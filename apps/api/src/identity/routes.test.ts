import { ErrorResponse } from "@kuutti/schema";
import { generateHetu } from "@kuutti/tunnistus-oidc/hetu";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { captureLogger, test, testConfig } from "../test/harness.ts";
import { BrokerError, type BrokerIdentity, type IdentityBroker } from "./broker.ts";
import { deriveIdentity, hmacKeyFromHex } from "./hetu.ts";

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
  authenticatedAt?: Date,
) {
  const { logger, lines } = await captureLogger();
  const broker = fakeBroker(hetu, authenticatedAt);
  const app = createApp({
    config: testConfig({
      HETU_HMAC_KEY: KEY_HEX,
      OIDC_ISSUER: "https://broker.test/uas",
      OIDC_CLIENT_ID: "kuutti-test",
      OIDC_REDIRECT_URI: "https://api.test/auth/callback",
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
    const { app } = await appWith(ctx, ADULT_HETU, anHourAgo);
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
