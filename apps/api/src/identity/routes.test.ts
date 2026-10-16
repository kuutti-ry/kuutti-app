import type { Queryable } from "@kuutti/db";
import { ErrorResponse } from "@kuutti/schema";
import { generateHetu } from "@kuutti/tunnistus-oidc/hetu";
import type { QueryResultRow } from "pg";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { captureLogger, test, testConfig, testPool } from "../test/harness.ts";
import { BrokerError, type BrokerIdentity, type IdentityBroker } from "./broker.ts";
import { AUTH_REQUEST_CAP, AUTH_REQUEST_TTL_MS } from "./codes.ts";
import { deriveIdentity, hmacKeyFromHex } from "./hetu.ts";
import { type LoginDeps, startLogin } from "./login.ts";
import * as repo from "./repo.ts";

// The bank login end to end through the routes, with a broker that answers
// what a bank would (#33). Real Postgres, one rolled-back transaction per test.

const KEY_HEX = "ab".repeat(32);
const NOW = new Date("2026-10-01T12:00:00Z");

/** A deterministic generator: the same sequence every run, so the hetus repeat. */
function rngFrom(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}
const ADULT_HETU = generateHetu(rngFrom(7), { at: NOW, minAge: 25, maxAge: 40 });
const MINOR_HETU = generateHetu(rngFrom(8), { at: NOW, minAge: 15, maxAge: 17 });

/** Answers like a broker whose person is `hetu`; records what it was asked. */
function fakeBroker(
  hetu: string,
  authenticatedAt = new Date(),
): IdentityBroker & { started: string[]; completed: string[] } {
  const started: string[] = [];
  const completed: string[] = [];
  return {
    issuer: "https://broker.test/uas",
    started,
    completed,
    async startLogin(input) {
      started.push(input.state);
      const url = new URL("https://broker.test/uas/oauth2/authorization");
      url.searchParams.set("state", input.state);
      url.searchParams.set("nonce", input.nonce);
      return url;
    },
    async completeLogin(input): Promise<BrokerIdentity> {
      completed.push(input.state);
      const code = input.callbackUrl.searchParams.get("code");
      if (code === "broken") throw new Error("bad code");
      // The adapter's own refusal, and something that is not an Error at all.
      if (code === "refused") throw new BrokerError("unexpected acr");
      if (code === "garbage") throw { not: "an error" };
      return {
        hetu,
        subject: "2BY5CDNFBEOSUFSKNGFSY4Y3DZISGL4I",
        sessionIndex: "_cb08aaa8",
        tokenId: "72b11a11",
        authenticatedAt,
        acr: "http://ftn.ficora.fi/2017/loatest2",
        amr: ["https://tunnistus-pp.telia.fi/uas/saml2/names/ac/oidc.aktia.1"],
      };
    },
  };
}

async function appWith(
  ctx: { client: Parameters<typeof createApp>[0]["db"] },
  hetu: string,
  options: { authenticatedAt?: Date; config?: Record<string, string> } = {},
) {
  const { logger, lines } = await captureLogger();
  const broker = fakeBroker(hetu, options.authenticatedAt);
  const app = createApp({
    config: testConfig({
      HETU_HMAC_KEY: KEY_HEX,
      OIDC_ISSUER: "https://broker.test/uas",
      OIDC_CLIENT_ID: "kuutti-test",
      OIDC_REDIRECT_URI: "https://api.test/auth/callback",
      ...options.config,
    }),
    logger,
    db: ctx.client,
    broker,
  });
  return { app, broker, logs: lines };
}

/** Runs /auth/start and returns the state the broker was given. */
async function start(app: ReturnType<typeof createApp>) {
  const res = await app.request("/auth/start?platform=ios&locale=fi");
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  expect(location.origin).toBe("https://broker.test");
  const state = location.searchParams.get("state");
  if (!state) throw new Error("no state in the redirect");
  return state;
}

async function callback(app: ReturnType<typeof createApp>, state: string, code = "good") {
  return app.request(`/auth/callback?code=${code}&state=${encodeURIComponent(state)}`);
}

async function codeFrom(res: Response): Promise<string> {
  expect(res.status).toBe(302);
  const location = res.headers.get("location") ?? "";
  expect(location.startsWith("kuutti://auth?code=")).toBe(true);
  return new URL(location).searchParams.get("code") ?? "";
}

async function exchange(app: ReturnType<typeof createApp>, code: string) {
  return app.request("/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

async function errorCode(res: Response): Promise<string> {
  return ErrorResponse.parse(await res.json()).error.code;
}

/** A refused callback sends the browser back into the app with the code. */
function refusal(res: Response): { error: string | null; until: string | null } {
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  expect(location.protocol).toBe("kuutti:");
  return { error: location.searchParams.get("error"), until: location.searchParams.get("until") };
}

describe("bank login", () => {
  test("A login starts with the platform recorded and the browser sent to the bank chooser", async ({
    ctx,
  }) => {
    const { app, broker } = await appWith(ctx, ADULT_HETU);
    expect((await app.request("/auth/start")).status).toBe(400);
    expect((await app.request("/auth/start?platform=web")).status).toBe(400);
    const state = await start(app);
    expect(broker.started).toEqual([state]);
    const rows = await ctx.client.query(
      "SELECT platform, locale FROM auth_request WHERE state = $1",
      [state],
    );
    expect(rows.rows[0]).toEqual({ platform: "ios", locale: "fi" });
  });

  test("An authentication that predates the login attempt is refused", async ({ ctx }) => {
    // ADR-016: the request object asked for the bank (prompt=login); an
    // auth_time from before the attempt began is a reused web session, not
    // the login of this person. Nothing is created.
    const anHourAgo = new Date(Date.now() - 60 * 60_000);
    const { app } = await appWith(ctx, ADULT_HETU, { authenticatedAt: anHourAgo });
    const state = await start(app);
    expect(refusal(await callback(app, state))).toEqual({
      error: "auth_provider_error",
      until: null,
    });
    const { hetuHmac } = deriveIdentity(ADULT_HETU, hmacKeyFromHex(KEY_HEX), NOW);
    const identity = await ctx.client.query("SELECT id FROM identity WHERE hetu_hmac = $1", [
      hetuHmac,
    ]);
    expect(identity.rowCount).toBe(0);
  });

  test("A first login creates the identity and the account and the code is exchanged once", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx, ADULT_HETU);
    const state = await start(app);
    const code = await codeFrom(await callback(app, state));

    const first = await exchange(app, code);
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.outcome).toBe("created");
    expect(body.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const me = await app.request("/auth/session", {
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.status).toBe(200);
    const session = await me.json();

    const identity = await ctx.client.query(
      "SELECT hetu_hmac, broker_subject, acr, amr, refused_attempts FROM identity",
    );
    expect(identity.rows).toHaveLength(1);
    expect(identity.rows[0]?.hetu_hmac).toBe(
      deriveIdentity(ADULT_HETU, hmacKeyFromHex(KEY_HEX), NOW).hetuHmac,
    );
    expect(identity.rows[0]?.broker_subject).toBe("2BY5CDNFBEOSUFSKNGFSY4Y3DZISGL4I");
    const account = await ctx.client.query(
      "SELECT id, state, birth_year, birth_month FROM account",
    );
    expect(account.rows).toHaveLength(1);
    expect(account.rows[0]?.id).toBe(session.accountId);
    expect(account.rows[0]?.state).toBe("registered");

    const second = await exchange(app, code);
    expect(second.status).toBe(401);
    expect(await errorCode(second)).toBe("auth_code_used");

    // The hetu was among the inputs of the callback and never in a log line; nor were the tokens.
    expect(JSON.stringify(logs())).not.toContain(ADULT_HETU);
    expect(JSON.stringify(logs())).not.toContain(ADULT_HETU.slice(0, 6));
    expect(JSON.stringify(logs())).not.toContain(body.accessToken);
    expect(JSON.stringify(logs())).not.toContain(body.refreshToken);
    // The one line a login leaves (#33): the level, the method and the decision.
    expect(logs().find((line) => line.msg === "bank login")).toMatchObject({
      acr: "http://ftn.ficora.fi/2017/loatest2",
      amr: ["https://tunnistus-pp.telia.fi/uas/saml2/names/ac/oidc.aktia.1"],
      outcome: "created",
    });
  });

  test("A second login of the same person resumes the live account", async ({ ctx }) => {
    const { app } = await appWith(ctx, ADULT_HETU);
    const one = await exchange(app, await codeFrom(await callback(app, await start(app))));
    const two = await exchange(app, await codeFrom(await callback(app, await start(app))));
    const a = await one.json();
    const b = await two.json();
    expect(b.outcome).toBe("resumed");
    const accountOf = async (token: string) =>
      (
        await (
          await app.request("/auth/session", { headers: { authorization: `Bearer ${token}` } })
        ).json()
      ).accountId;
    expect(await accountOf(b.accessToken)).toBe(await accountOf(a.accessToken));
    const accounts = await ctx.client.query("SELECT count(*) AS n FROM account");
    expect(Number(accounts.rows[0]?.n)).toBe(1);
  });

  test("The next bank login resumes a paused account as it was", async ({ ctx }) => {
    const { app } = await appWith(ctx, ADULT_HETU);
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
    const first = await (
      await exchange(app, await codeFrom(await callback(app, await start(app))))
    ).json();
    // Onboarding finished, as the break requires (ADR-022 §1).
    await ctx.client.query("UPDATE account SET state = 'active' WHERE state = 'registered'");
    const paused = await app.request("/account/pause", {
      method: "POST",
      headers: { ...bearer(first.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(paused.status).toBe(204);
    expect(
      (await app.request("/auth/session", { headers: bearer(first.accessToken) })).status,
    ).toBe(401);

    const second = await (
      await exchange(app, await codeFrom(await callback(app, await start(app))))
    ).json();
    expect(second.outcome).toBe("unpaused");
    const { rows } = await ctx.client.query("SELECT state, paused_from FROM account");
    expect(rows).toEqual([{ state: "active", paused_from: null }]);
    expect(
      (await app.request("/auth/session", { headers: bearer(second.accessToken) })).status,
    ).toBe(200);
    // The break has ended: the login after that is a plain resume.
    const third = await (
      await exchange(app, await codeFrom(await callback(app, await start(app))))
    ).json();
    expect(third.outcome).toBe("resumed");
  });

  test("An unknown state, a used state and a broker failure each send the browser back with a code", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx, ADULT_HETU);
    expect(refusal(await callback(app, "not-a-state")).error).toBe("auth_state_mismatch");

    const state = await start(app);
    await codeFrom(await callback(app, state));
    expect(refusal(await callback(app, state)).error).toBe("auth_state_mismatch");

    expect(refusal(await callback(app, await start(app), "broken")).error).toBe(
      "auth_provider_error",
    );

    const odd = await app.request(
      `/auth/callback?error=server_error&state=${encodeURIComponent(await start(app))}`,
    );
    expect(refusal(odd).error).toBe("auth_provider_error");
  });

  test("A person who cancels at the bank is sent back with auth_cancelled", async ({ ctx }) => {
    // Guide 2.5.2: the broker answers error=access_denied and no code.
    const { app, logs } = await appWith(ctx, ADULT_HETU);
    const state = await start(app);
    const back = await app.request(
      `/auth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );
    expect(refusal(back).error).toBe("auth_cancelled");
    // The attempt is spent: the state cannot be replayed with a code later.
    expect(refusal(await callback(app, state)).error).toBe("auth_state_mismatch");
    expect(JSON.stringify(logs())).not.toContain("provider");
    const rows = await ctx.client.query("SELECT count(*) AS n FROM identity");
    expect(Number(rows.rows[0]?.n)).toBe(0);
  });

  test("A minor is refused and nothing is stored", async ({ ctx }) => {
    const { app } = await appWith(ctx, MINOR_HETU);
    expect(refusal(await callback(app, await start(app))).error).toBe("auth_under_18");
    const rows = await ctx.client.query("SELECT count(*) AS n FROM identity");
    expect(Number(rows.rows[0]?.n)).toBe(0);
  });

  test("A banned identity is refused and the attempt is counted", async ({ ctx }) => {
    const { app } = await appWith(ctx, ADULT_HETU);
    const { hetuHmac } = deriveIdentity(ADULT_HETU, hmacKeyFromHex(KEY_HEX), NOW);
    await ctx.client.query("INSERT INTO identity (hetu_hmac, standing) VALUES ($1, 'banned')", [
      hetuHmac,
    ]);
    expect(refusal(await callback(app, await start(app))).error).toBe("auth_banned");
    const rows = await ctx.client.query(
      "SELECT refused_attempts, (SELECT count(*) FROM account) AS accounts FROM identity",
    );
    expect(rows.rows[0]).toMatchObject({ refused_attempts: 1, accounts: "0" });
  });

  test("A cooling-down identity is refused with the date and gets a fresh account afterwards", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx, ADULT_HETU);
    const { hetuHmac } = deriveIdentity(ADULT_HETU, hmacKeyFromHex(KEY_HEX), NOW);
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await ctx.client.query(
      "INSERT INTO identity (hetu_hmac, deletion_count, reregister_after) VALUES ($1, 1, $2)",
      [hetuHmac, until],
    );
    const refused = refusal(await callback(app, await start(app)));
    expect(refused.error).toBe("auth_cooldown");
    expect(refused.until).toBe(until.toISOString());

    await ctx.client.query("UPDATE identity SET reregister_after = now() - interval '1 second'");
    const fresh = await exchange(app, await codeFrom(await callback(app, await start(app))));
    expect((await fresh.json()).outcome).toBe("created");
  });

  test("The exchange validates the code and refuses an unknown one", async ({ ctx }) => {
    const { app } = await appWith(ctx, ADULT_HETU);
    expect((await exchange(app, "short")).status).toBe(400);
    const unknown = await exchange(app, "A".repeat(43));
    expect(unknown.status).toBe(401);
    expect(await errorCode(unknown)).toBe("auth_code_used");
  });

  test("Without a broker the login answers 503", async ({ ctx }) => {
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: ctx.client });
    const res = await app.request("/auth/start?platform=android");
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe("auth_provider_error");
  });

  test("A preview's login sends the app back with auth_unavailable", async ({ ctx }) => {
    const { logger } = await captureLogger();
    const config = testConfig({ APP_ENV: "preview", PR_NUMBER: "125" });
    const app = createApp({ config, logger, db: ctx.client });
    const res = await app.request("/auth/start?platform=android");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("kuutti://auth?error=auth_unavailable");
    // A request the app could not have sent is still refused first.
    expect((await app.request("/auth/start?platform=web")).status).toBe(400);
  });
});

describe("the callback's refusals and failures", () => {
  /** The warning the callback writes for a refusal it turns into a redirect. */
  const refusalLine = (logs: () => Array<Record<string, unknown>>, code: string) =>
    logs().find((l) => l.code === code && l.level === 40);

  test("A broker error in free text reaches the log as unnamed, never as its words", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx, ADULT_HETU);
    const words = "Something Odd Happened";
    const res = await app.request(
      `/auth/callback?error=${encodeURIComponent(words)}&state=${encodeURIComponent(await start(app))}`,
    );
    expect(refusal(res)).toEqual({ error: "auth_provider_error", until: null });
    expect(refusalLine(logs, "auth_provider_error")).toMatchObject({
      detail: { detail: "broker answered unnamed error" },
    });
    expect(JSON.stringify(logs())).not.toContain("Odd");
  });

  test("A suspended identity is refused with auth_suspended, with the instant it ends when it has one, and the attempt is counted", async ({
    ctx,
  }) => {
    const { app, broker } = await appWith(ctx, ADULT_HETU);
    const { hetuHmac } = deriveIdentity(ADULT_HETU, hmacKeyFromHex(KEY_HEX), NOW);
    // A suspension without an end: a row set by hand, or written before the column existed.
    const identity = await ctx.client.query<{ id: string }>(
      "INSERT INTO identity (hetu_hmac, standing) VALUES ($1, 'suspended') RETURNING id",
      [hetuHmac],
    );
    const id = identity.rows[0]?.id;
    expect(refusal(await callback(app, await start(app)))).toEqual({
      error: "auth_suspended",
      until: null,
    });
    // A sanction's suspension: the start of 22.10.2026 in Finland travels as &until= (ADR-024 §5).
    await ctx.client.query(
      "UPDATE identity SET suspension_ends_at = '2026-10-21T21:00:00Z' WHERE id = $1",
      [id],
    );
    expect(refusal(await callback(app, await start(app)))).toEqual({
      error: "auth_suspended",
      until: "2026-10-21T21:00:00.000Z",
    });
    expect(broker.completed).toHaveLength(2);
    const rows = await ctx.client.query(
      "SELECT refused_attempts, (SELECT count(*) FROM account WHERE identity_id = $1) AS accounts FROM identity WHERE id = $1",
      [id],
    );
    expect(rows.rows[0]).toMatchObject({ refused_attempts: 2, accounts: "0" });
  });

  test("The adapter's refusal keeps its reason and anything else it throws is a provider error too", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx, ADULT_HETU);
    expect(refusal(await callback(app, await start(app), "refused")).error).toBe(
      "auth_provider_error",
    );
    expect(refusalLine(logs, "auth_provider_error")).toMatchObject({
      detail: { detail: "unexpected acr" },
    });
    expect(refusal(await callback(app, await start(app), "garbage")).error).toBe(
      "auth_provider_error",
    );
    expect(
      logs()
        .filter((l) => l.code === "auth_provider_error")
        .map((l) => l.detail),
    ).toContainEqual({ detail: "broker failed" });
    // Never a bare 500: no unhandled-error line for either.
    expect(logs().filter((l) => l.msg === "unhandled error")).toEqual([]);
  });

  test("An invalid identity code from the broker is a provider error naming the check, never the code", async ({
    ctx,
  }) => {
    const invalid = "010190-123B"; // a wrong check character
    const { app, logs } = await appWith(ctx, invalid);
    expect(refusal(await callback(app, await start(app))).error).toBe("auth_provider_error");
    expect(refusalLine(logs, "auth_provider_error")).toMatchObject({
      detail: {
        detail: "the identification service returned an invalid personal identity code (checksum)",
      },
    });
    expect(JSON.stringify(logs())).not.toContain(invalid);
    expect(JSON.stringify(logs())).not.toContain("010190");
    const rows = await ctx.client.query(
      "SELECT count(*) AS n FROM identity WHERE broker_subject = '2BY5CDNFBEOSUFSKNGFSY4Y3DZISGL4I'",
    );
    expect(Number(rows.rows[0]?.n)).toBe(0);
  });

  test("A callback without a state is refused as invalid before anything is looked up", async ({
    ctx,
  }) => {
    const { app, broker } = await appWith(ctx, ADULT_HETU);
    for (const query of ["?code=good", "?code=good&state=", `?state=s&error=${"x".repeat(65)}`]) {
      const res = await app.request(`/auth/callback${query}`);
      expect(res.status, query).toBe(400);
      expect(await errorCode(res), query).toBe("validation_failed");
    }
    expect(broker.completed).toEqual([]);
  });

  test("An attempt past its ten minutes is refused and the bank's answer is never exchanged", async ({
    ctx,
  }) => {
    const { app, broker } = await appWith(ctx, ADULT_HETU);
    // Started without a language, eleven minutes ago.
    await ctx.client.query(
      `INSERT INTO auth_request (state, nonce, platform, expires_at)
       VALUES ('st-stale', 'n-stale', 'ios', now() - interval '1 minute')`,
    );
    expect(refusal(await callback(app, "st-stale")).error).toBe("auth_state_mismatch");
    expect(broker.completed).toEqual([]);
  });

  test("A callback reaching an API without a broker sends the browser back with auth_provider_error", async ({
    ctx,
  }) => {
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: ctx.client });
    expect(refusal(await callback(app, "any-state")).error).toBe("auth_provider_error");
  });

  test("A failure that is not a refusal is a 500 the error sink sees, not a redirect", async () => {
    const { logger, lines } = await captureLogger();
    const reported: unknown[] = [];
    const down = {
      query: () => Promise.reject(new Error("connection terminated unexpectedly")),
    } as unknown as Parameters<typeof createApp>[0]["db"];
    const app = createApp({
      config: testConfig({ HETU_HMAC_KEY: KEY_HEX }),
      logger,
      db: down,
      broker: fakeBroker(ADULT_HETU),
      report: (error) => reported.push(error),
    });
    const res = await app.request("/auth/callback?code=good&state=some-state");
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
    expect(await errorCode(res)).toBe("internal_error");
    expect(reported).toHaveLength(1);
    expect(lines().filter((l) => l.msg === "unhandled error")).toHaveLength(1);
  });

  test("A preview handed a broker still has no key, and sends the app back without asking the bank", async ({
    ctx,
  }) => {
    const { logger } = await captureLogger();
    const broker = fakeBroker(ADULT_HETU);
    // A preview's configuration drops the HMAC key whatever is set (ADR-014 §1).
    const config = testConfig({ APP_ENV: "preview", PR_NUMBER: "125", HETU_HMAC_KEY: KEY_HEX });
    expect(config.HETU_HMAC_KEY).toBeUndefined();
    const app = createApp({ config, logger, db: ctx.client, broker });
    const res = await app.request("/auth/start?platform=ios");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("kuutti://auth?error=auth_unavailable");
    expect(broker.started).toEqual([]);
  });

  test("The start refuses a language the bank chooser does not have", async ({ ctx }) => {
    const { app, broker } = await appWith(ctx, ADULT_HETU);
    const res = await app.request("/auth/start?platform=ios&locale=de");
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("validation_failed");
    expect(broker.started).toEqual([]);
  });
});

describe("the exchange", () => {
  async function loggedIn(ctx: { client: Parameters<typeof createApp>[0]["db"] }) {
    const { app } = await appWith(ctx, ADULT_HETU);
    const state = await start(app);
    const code = await codeFrom(await callback(app, state));
    return { app, state, code };
  }

  test("An expired one-time code is refused and opens no session", async ({ ctx }) => {
    const { app, state, code } = await loggedIn(ctx);
    await ctx.client.query(
      "UPDATE auth_request SET code_expires_at = now() - interval '1 second' WHERE state = $1",
      [state],
    );
    const res = await exchange(app, code);
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("auth_code_used");
    const rows = await ctx.client.query(
      "SELECT count(*) AS n FROM session WHERE account_id = (SELECT account_id FROM auth_request WHERE state = $1)",
      [state],
    );
    expect(Number(rows.rows[0]?.n)).toBe(0);
    // Refused before it was spent: the attempt still reads as never used.
    const attempt = await ctx.client.query(
      "SELECT code_used_at FROM auth_request WHERE state = $1",
      [state],
    );
    expect(attempt.rows).toEqual([{ code_used_at: null }]);
  });

  test("The exchange takes exactly the code and nothing else", async ({ ctx }) => {
    const { app, code } = await loggedIn(ctx);
    for (const body of [{}, { code, extra: true }, { code: 42 }]) {
      const res = await app.request("/auth/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await errorCode(res)).toBe("validation_failed");
    }
    // None of the refused bodies spent the code.
    expect((await exchange(app, code)).status).toBe(200);
  });

  test("The device is named by its user agent, cut to two hundred characters, or by nothing", async ({
    ctx,
  }) => {
    const first = await loggedIn(ctx);
    const res = await first.app.request("/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `Kuutti/1 ${"x".repeat(300)}` },
      body: JSON.stringify({ code: first.code }),
    });
    expect(res.status).toBe(200);
    const long = (await res.json()) as { sessionId: string };
    const second = await loggedIn(ctx);
    const bare = await second.app.request("/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: second.code }),
    });
    expect(bare.status).toBe(200);
    const none = (await bare.json()) as { sessionId: string };
    const rows = await ctx.client.query<{ id: string; user_agent: string | null }>(
      "SELECT id, user_agent FROM session WHERE id = ANY($1)",
      [[long.sessionId, none.sessionId]],
    );
    const agent = new Map(rows.rows.map((r) => [r.id, r.user_agent]));
    expect(agent.get(long.sessionId)).toBe(`Kuutti/1 ${"x".repeat(191)}`);
    expect(agent.get(none.sessionId)).toBeNull();
  });
});

// The sign-in doors (ADR-026 §4): one window per client address across the
// two starts, ahead of their handlers. Each request's address is the one
// Traefik reports (ADR-008 §5), from the documentation ranges, so no test's
// address is anybody's.
const TWO_A_MINUTE = { SIGN_IN_RATE_LIMIT_PER_MINUTE: "2", TRUSTED_PROXY: "traefik" };
const HERE = "203.0.113.7";
const THERE = "198.51.100.23";
const ANY_ADDRESS = /203\.0\.113|198\.51\.100|2001:db8/;

type Db = { client: Parameters<typeof createApp>[0]["db"] };

const from = (address: string) => ({ "x-forwarded-for": address });

const startFrom = (app: ReturnType<typeof createApp>, address: string, query = "platform=ios") =>
  app.request(`/auth/start?${query}`, { headers: from(address) });

const exchangeFrom = (app: ReturnType<typeof createApp>, address: string, code: string) =>
  app.request("/auth/exchange", {
    method: "POST",
    headers: { ...from(address), "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });

/** Where a start sent the browser: the broker's origin, or the app's link whole. */
const sentTo = (res: Response) => {
  expect(res.status).toBe(302);
  const location = res.headers.get("location") ?? "";
  return location.startsWith("kuutti:") ? location : new URL(location).origin;
};

const attempts = async (ctx: Db) =>
  Number(
    (await ctx.client.query<{ n: string }>("SELECT count(*) AS n FROM auth_request")).rows[0]?.n,
  );

/** The lines a refused sign-in leaves (routes.ts, login.ts), one per refusal or eviction. */
const refusedLines = (logs: () => Array<Record<string, unknown>>) =>
  logs().filter((l) => l.msg === "sign-in refused");

describe("the sign-in doors (ADR-026 §4)", () => {
  test("A flood of logins from one address is refused before anything is written", async ({
    ctx,
  }) => {
    const { app, broker, logs } = await appWith(ctx, ADULT_HETU, { config: TWO_A_MINUTE });
    expect(sentTo(await startFrom(app, HERE))).toBe("https://broker.test");
    expect(sentTo(await startFrom(app, HERE))).toBe("https://broker.test");
    const before = await attempts(ctx);

    const refused = await startFrom(app, HERE);
    expect(sentTo(refused)).toBe("kuutti://auth?error=auth_rate_limited");
    const wait = Number(refused.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
    expect(await attempts(ctx)).toBe(before);
    expect(broker.started).toHaveLength(2);

    // Another address has a window of its own.
    expect(sentTo(await startFrom(app, THERE))).toBe("https://broker.test");
    expect(broker.started).toHaveLength(3);
    // One line names the code and the limit that refused it, and no line names an address (§7).
    expect(refusedLines(logs)).toEqual([
      expect.objectContaining({
        level: 40,
        code: "auth_rate_limited",
        detail: { limiter: "address" },
      }),
    ]);
    expect(JSON.stringify(logs())).not.toMatch(ANY_ADDRESS);
  });

  test("a start the validation refuses still spends the window, and past it is sent back like any other", async ({
    ctx,
  }) => {
    const { app, broker } = await appWith(ctx, ADULT_HETU, { config: TWO_A_MINUTE });
    expect((await startFrom(app, HERE, "platform=web")).status).toBe(400);
    expect((await startFrom(app, HERE, "platform=ios&locale=de")).status).toBe(400);
    expect(sentTo(await startFrom(app, HERE))).toBe("kuutti://auth?error=auth_rate_limited");
    // The doors stand before the validation: past the window nothing is read.
    expect(sentTo(await startFrom(app, HERE, "platform=web"))).toBe(
      "kuutti://auth?error=auth_rate_limited",
    );
    expect(broker.started).toEqual([]);
    expect(await attempts(ctx)).toBe(0);
  });

  test("an exchange is no door: past the doors' window it answers for itself, and only the address's limit refuses it", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx, ADULT_HETU, {
      config: { ...TWO_A_MINUTE, RATE_LIMIT_PER_MINUTE: "4" },
    });
    const unknown = "A".repeat(43);
    for (const _ of [1, 2, 3, 4]) {
      const res = await exchangeFrom(app, HERE, unknown);
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe("auth_code_used");
    }
    // The address's own limit, as on any route: the contract's 429.
    const refused = await exchangeFrom(app, HERE, unknown);
    expect(refused.status).toBe(429);
    expect(await errorCode(refused)).toBe("rate_limited");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(refusedLines(logs)).toEqual([]);
    expect((await exchangeFrom(app, THERE, unknown)).status).toBe(401);
  });

  test("a whole login spends one of the window, the two starts share it, and the exchange, the callback and the refresh are not doors", async ({
    ctx,
  }) => {
    const { app, broker } = await appWith(ctx, ADULT_HETU, { config: TWO_A_MINUTE });
    const started = await startFrom(app, HERE);
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const back = await app.request(`/auth/callback?code=good&state=${encodeURIComponent(state)}`, {
      headers: from(HERE),
    });
    expect((await exchangeFrom(app, HERE, await codeFrom(back))).status).toBe(200);

    // The staff start counts in the same window as the app's: it is the second.
    const staffStart = await app.request("/admin/auth/start", { headers: from(HERE) });
    expect(new URL(staffStart.headers.get("location") ?? "").origin).toBe("https://broker.test");
    expect(sentTo(await startFrom(app, HERE))).toBe("kuutti://auth?error=auth_rate_limited");
    const staffRefused = await app.request("/admin/auth/start", { headers: from(HERE) });
    expect(staffRefused.status).toBe(302);
    expect(new URL(staffRefused.headers.get("location") ?? "").hash).toBe(
      "#error=auth_rate_limited",
    );
    expect(broker.started).toHaveLength(2);

    // Past the window the exchanges, the callback and the refresh answer for themselves (ADR-026 §4).
    const staffExchange = await app.request("/admin/auth/exchange", {
      method: "POST",
      headers: { ...from(HERE), "content-type": "application/json" },
      body: JSON.stringify({ code: "A".repeat(43) }),
    });
    expect(staffExchange.status).toBe(401);
    expect(await errorCode(staffExchange)).toBe("auth_code_used");
    const appExchange = await exchangeFrom(app, HERE, "A".repeat(43));
    expect(appExchange.status).toBe(401);
    expect(await errorCode(appExchange)).toBe("auth_code_used");
    expect(
      refusal(await app.request("/auth/callback?code=good&state=gone", { headers: from(HERE) }))
        .error,
    ).toBe("auth_state_mismatch");
    const refresh = await app.request("/auth/refresh", {
      method: "POST",
      headers: { ...from(HERE), "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "B".repeat(43) }),
    });
    expect(refresh.status).toBe(401);
    expect(await errorCode(refresh)).toBe("session_revoked");
  });

  test("the doors count an IPv6 client by its /56: the 256 /64s of one share a window, and another /56 has its own", async ({
    ctx,
  }) => {
    const { app, broker, logs } = await appWith(ctx, ADULT_HETU, {
      config: { SIGN_IN_RATE_LIMIT_PER_MINUTE: "256", TRUSTED_PROXY: "traefik" },
    });
    // 2001:db8:4711:ab00::/56 holds the /64s 2001:db8:4711:ab00 to 2001:db8:4711:abff.
    for (let i = 0; i < 256; i += 1) {
      const sixtyFour = `2001:db8:4711:ab${i.toString(16).padStart(2, "0")}::1`;
      expect(sentTo(await startFrom(app, sixtyFour))).toBe("https://broker.test");
    }
    expect(sentTo(await startFrom(app, "2001:db8:4711:ab42:1:2:3:4"))).toBe(
      "kuutti://auth?error=auth_rate_limited",
    );
    expect(sentTo(await startFrom(app, "2001:db8:4711:ac00::1"))).toBe("https://broker.test");
    expect(broker.started).toHaveLength(257);
    expect(JSON.stringify(logs())).not.toMatch(ANY_ADDRESS);
  });
});

/** The attempts' states, oldest first. */
const states = async (ctx: Db) =>
  (
    await ctx.client.query<{ state: string }>("SELECT state FROM auth_request ORDER BY expires_at")
  ).rows.map((r) => r.state);

/**
 * Attempts until the table holds `rows`, each a second younger than the one
 * before, so that `full-1` is the oldest: open unless `expired`, and holding
 * a code still live when `coded`.
 */
async function fillTo(ctx: Db, rows: number, rowsAre: { expired?: boolean; coded?: boolean } = {}) {
  await ctx.client.query(
    `INSERT INTO auth_request (state, nonce, platform, expires_at, code_hash, code_expires_at)
     SELECT 'full-' || n, 'n-' || n, 'ios',
            now() + CASE WHEN $2 THEN interval '-1 hour' ELSE interval '1 minute' END + n * interval '1 second',
            CASE WHEN $3 THEN 'h-' || n END,
            CASE WHEN $3 THEN now() + interval '1 minute' END
     FROM generate_series(1, $1) AS n`,
    [rows - (await attempts(ctx)), rowsAre.expired === true, rowsAre.coded === true],
  );
  expect(await attempts(ctx)).toBe(rows);
}

/** A ceiling a test fills in a moment; the routes' own is AUTH_REQUEST_CAP. */
const SMALL_CAP = 5;

/** startLogin itself, on `db`, against SMALL_CAP. */
async function starter(db: Queryable) {
  const { logger, lines } = await captureLogger();
  const broker = fakeBroker(ADULT_HETU);
  const deps: LoginDeps = {
    db,
    broker,
    hmacKey: hmacKeyFromHex(KEY_HEX),
    now: () => new Date(),
    logger,
    adminAppUrl: "https://admin.test",
  };
  return {
    broker,
    logs: lines,
    start: () => startLogin(deps, { platform: "ios", locale: null }, SMALL_CAP),
  };
}

/**
 * The test's transaction with another request's work slipped in once, just
 * before (or after) the first statement matching the pattern, as if a
 * concurrent request had committed at that point (races.test.ts); `ran` says
 * the moment came.
 */
function interleaved(
  db: Queryable,
  at: { before?: RegExp; after?: RegExp },
  other: () => Promise<unknown>,
) {
  let ran = false;
  return {
    ran: () => ran,
    async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      if (!ran && at.before?.test(text)) {
        ran = true;
        await other();
      }
      const result = await db.query<R>(text, values);
      if (!ran && at.after?.test(text)) {
        ran = true;
        await other();
      }
      return result;
    },
  };
}

/** `db`, keeping the text of every statement run through it, in order. */
function recording(db: Queryable) {
  const texts: string[] = [];
  return {
    texts,
    query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      texts.push(text);
      return db.query<R>(text, values);
    },
  };
}

/** The statements that count the whole table. */
const COUNTS_THE_TABLE = /count\(\*\) FROM auth_request/;

/** The statement that ends unanswered attempts and inserts the start's own (repo.ts). */
const EVICT_AND_INSERT = /^WITH gone AS \(\s*DELETE FROM auth_request/;

describe("the table's ceiling (ADR-026 §6)", () => {
  test("At the table's cap a login makes room by ending the oldest unanswered attempts", async ({
    ctx,
  }) => {
    await fillTo(ctx, SMALL_CAP);
    const db = recording(ctx.client);
    const { broker, logs, start } = await starter(db);
    await start();
    // Two go and one comes, so a table that concurrent starts left past its
    // cap drains back under it.
    expect(await states(ctx)).toEqual(["full-3", "full-4", "full-5", ...broker.started]);
    // The table is counted once: the eviction and the insert are one
    // statement on the primary key, with no count of its own.
    expect(db.texts.filter((text) => COUNTS_THE_TABLE.test(text))).toHaveLength(1);
    expect(db.texts.filter((text) => EVICT_AND_INSERT.test(text))).toHaveLength(1);
    // The line a runbook counts: this start went on, the attempts it ended did not.
    expect(refusedLines(logs)).toEqual([
      expect.objectContaining({ level: 40, detail: { limiter: "evicted", evicted: 2 } }),
    ]);
    expect(refusedLines(logs)[0]).not.toHaveProperty("code");
  });

  test("an attempt that holds a code is never ended to make room, however old", async ({ ctx }) => {
    await fillTo(ctx, SMALL_CAP);
    // The two oldest have been to the bank: one code waits for its exchange, one was used.
    await ctx.client.query(
      `UPDATE auth_request SET code_hash = 'h-' || state, code_expires_at = now() + interval '1 minute',
         code_used_at = CASE WHEN state = 'full-2' THEN now() END
       WHERE state IN ('full-1', 'full-2')`,
    );
    const { broker, start } = await starter(ctx.client);
    await start();
    expect(broker.started).toHaveLength(1);
    expect(await states(ctx)).toEqual(["full-1", "full-2", "full-5", ...broker.started]);
  });

  test("a table past its cap, as concurrent starts may leave it, drains back under the cap, one row a start", async ({
    ctx,
  }) => {
    await fillTo(ctx, SMALL_CAP + 2);
    const { broker, logs, start } = await starter(ctx.client);
    const sizes: number[] = [];
    for (let i = 0; i < 4; i++) {
      await start();
      sizes.push(await attempts(ctx));
    }
    // At or past the cap a start ends two and adds one; under it, the counted
    // insert adds one. The overshoot only ever shrinks.
    expect(sizes).toEqual([SMALL_CAP + 1, SMALL_CAP, SMALL_CAP - 1, SMALL_CAP]);
    expect(broker.started).toHaveLength(4);
    expect(refusedLines(logs).map((line) => line.detail)).toEqual([
      { limiter: "evicted", evicted: 2 },
      { limiter: "evicted", evicted: 2 },
      { limiter: "evicted", evicted: 2 },
    ]);
  });

  test("expired attempts make room first, and one whose code is still live keeps its place", async ({
    ctx,
  }) => {
    await fillTo(ctx, SMALL_CAP, { expired: true });
    // One of them has just had its code: the person may still exchange it.
    await ctx.client.query(
      "UPDATE auth_request SET code_hash = 'h', code_expires_at = now() + interval '1 minute' WHERE state = 'full-1'",
    );
    const { broker, logs, start } = await starter(ctx.client);
    await start();
    const [state] = broker.started;
    expect((await states(ctx)).sort()).toEqual(["full-1", state].sort());
    // Nothing unanswered and open had to go.
    expect(refusedLines(logs)).toEqual([]);
  });

  test("At the table's cap a login is refused only when every attempt holds a code", async ({
    ctx,
  }) => {
    // The routes' own ceiling, every row of it a code waiting for its
    // exchange: nobody can write one without the bank.
    await fillTo(ctx, AUTH_REQUEST_CAP, { coded: true });
    const { app, broker, logs } = await appWith(ctx, ADULT_HETU);
    const refused = await app.request("/auth/start?platform=ios");
    expect(sentTo(refused)).toBe("kuutti://auth?error=auth_rate_limited");
    expect(refused.headers.get("retry-after")).toBe("60");
    // A staff start goes back to the panel the same way.
    const staff = await app.request("/admin/auth/start");
    expect(staff.status).toBe(302);
    expect(new URL(staff.headers.get("location") ?? "").hash).toBe("#error=auth_rate_limited");
    expect(staff.headers.get("retry-after")).toBe("60");
    expect(await attempts(ctx)).toBe(AUTH_REQUEST_CAP);
    expect(broker.started).toEqual([]);
    const cap = expect.objectContaining({
      level: 40,
      code: "auth_rate_limited",
      detail: { limiter: "cap" },
    });
    expect(refusedLines(logs)).toEqual([cap, cap]);
  });

  test("a start at the cap while another is under way makes room of its own, and the table stays within its cap", async ({
    ctx,
  }) => {
    await fillTo(ctx, SMALL_CAP - 1);
    const other = await starter(ctx.client);
    // The other start commits just before this one's insert counts the table.
    const db = interleaved(ctx.client, { before: /INSERT INTO auth_request/ }, other.start);
    const { broker, start } = await starter(db);
    await start();
    expect(db.ran()).toBe(true);
    expect(other.broker.started).toHaveLength(1);
    expect(broker.started).toHaveLength(1);
    // The count and the insert are one statement, and so are the eviction
    // and the insert: on one connection the table never passes its cap.
    expect(await attempts(ctx)).toBe(SMALL_CAP - 1);
    const left = await states(ctx);
    expect(left).not.toContain("full-1");
    expect(left).not.toContain("full-2");
  });

  test("a start that runs between another's decision to evict and its eviction makes room of its own, and neither is refused", async ({
    ctx,
  }) => {
    await fillTo(ctx, SMALL_CAP);
    const other = await starter(ctx.client);
    // This start has found the table full; the other commits a start of its
    // own, eviction and all, before this one's eviction runs.
    const db = interleaved(ctx.client, { before: EVICT_AND_INSERT }, other.start);
    const { broker, logs, start } = await starter(db);
    await start();
    expect(db.ran()).toBe(true);
    expect(other.broker.started).toHaveLength(1);
    expect(broker.started).toHaveLength(1);
    // Each ended two: nothing in between can take the room an eviction makes.
    expect((await states(ctx)).sort()).toEqual(
      ["full-5", ...other.broker.started, ...broker.started].sort(),
    );
    expect(refusedLines(other.logs)).toEqual([
      expect.objectContaining({ detail: { limiter: "evicted", evicted: 2 } }),
    ]);
    expect(refusedLines(logs)).toEqual([
      expect.objectContaining({ detail: { limiter: "evicted", evicted: 2 } }),
    ]);
  });

  test("a start whose sweep of expired attempts frees a place that another start takes first still gets in, and neither is refused", async ({
    ctx,
  }) => {
    await fillTo(ctx, SMALL_CAP);
    await ctx.client.query(
      "UPDATE auth_request SET expires_at = now() - interval '1 hour' WHERE state = 'full-1'",
    );
    const other = await starter(ctx.client);
    // The other start commits just after this one's sweep, into the place it freed.
    const db = interleaved(
      ctx.client,
      { after: /DELETE FROM auth_request WHERE expires_at/ },
      other.start,
    );
    const { broker, logs, start } = await starter(db);
    await start();
    expect(db.ran()).toBe(true);
    expect(other.broker.started).toHaveLength(1);
    expect(broker.started).toHaveLength(1);
    // This start's second count found the table full again, so it ended the
    // two oldest unanswered attempts rather than refuse.
    expect((await states(ctx)).sort()).toEqual(
      ["full-4", "full-5", ...other.broker.started, ...broker.started].sort(),
    );
    expect(refusedLines(other.logs)).toEqual([]);
    expect(refusedLines(logs)).toEqual([
      expect.objectContaining({ detail: { limiter: "evicted", evicted: 2 } }),
    ]);
  });

  test("starts whose statements overlap on two connections each find room, so the table passes its cap by one a connection at most", async ({
    ctx,
  }) => {
    const second = await testPool().connect();
    try {
      await second.query("BEGIN");
      const cap = (await attempts(ctx)) + 1;
      const attempt = (state: string) => ({
        state,
        nonce: `n-${state}`,
        platform: "ios",
        locale: null,
        expiresAt: new Date(Date.now() + AUTH_REQUEST_TTL_MS),
      });
      // Neither sees the other's row before it commits, so both take the last place.
      expect(await repo.insertAuthRequest(ctx.client, attempt("overlap-a"), cap)).toBe(true);
      expect(await repo.insertAuthRequest(second, attempt("overlap-b"), cap)).toBe(true);
      // Each connection's next start sees its own row and is refused.
      expect(await repo.insertAuthRequest(ctx.client, attempt("overlap-c"), cap)).toBe(false);
      expect(await repo.insertAuthRequest(second, attempt("overlap-d"), cap)).toBe(false);
    } finally {
      await second.query("ROLLBACK").catch(() => undefined);
      second.release();
    }
  });
});
