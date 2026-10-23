import { createHash } from "node:crypto";
import type { Queryable } from "@kuutti/db";
import { ErrorResponse } from "@kuutti/schema";
import { generateHetu } from "@kuutti-ry/tunnistus-oidc/hetu";
import type { QueryResultRow } from "pg";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { CHALLENGE, VERIFIER } from "../test/attempt.ts";
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

/** A verifier well-formed and not the app's, with its challenge: another attempt's, or a guess (ADR-027). */
const OTHER_VERIFIER = "0dd5".repeat(16);
const OTHER_CHALLENGE = createHash("sha256").update(OTHER_VERIFIER).digest("hex");

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

/** Runs /auth/start, with the app's challenge unless told another, and returns the state the broker was given. */
async function start(app: ReturnType<typeof createApp>, challenge = CHALLENGE) {
  const res = await app.request(`/auth/start?platform=ios&locale=fi&code_challenge=${challenge}`);
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

/** POST /auth/exchange with any body, as the app or anybody else may send it. */
function exchangeWith(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The exchange of `code`, with the app's verifier unless told another. */
async function exchange(app: ReturnType<typeof createApp>, code: string, verifier = VERIFIER) {
  return exchangeWith(app, { code, verifier });
}

async function errorCode(res: Response): Promise<string> {
  return ErrorResponse.parse(await res.json()).error.code;
}

/** What a refusal tells the caller, all but its request id; a body that is no error reads as its status alone. */
async function answerOf(res: Response) {
  const error = ErrorResponse.safeParse(await res.json()).data?.error;
  return { status: res.status, code: error?.code, message: error?.message };
}

/**
 * The exchange's answer to a code nobody issued. Every refusal of a code is
 * this one answer, so that the caller learns nothing of which it was
 * (ADR-027): unknown, used, expired, a staff code, or a wrong verifier.
 */
async function unknownCodeAnswer(app: ReturnType<typeof createApp>) {
  const answer = await answerOf(await exchange(app, "A".repeat(43)));
  expect(answer).toMatchObject({ status: 401, code: "auth_code_used" });
  return answer;
}

/** When the attempt's code was spent, or null while it was not. */
async function codeUsedAt(ctx: { client: Queryable }, state: string) {
  const { rows } = await ctx.client.query<{ code_used_at: Date | null }>(
    "SELECT code_used_at FROM auth_request WHERE state = $1",
    [state],
  );
  expect(rows).toHaveLength(1);
  return rows[0]?.code_used_at ?? null;
}

const sessionCount = async (ctx: { client: Queryable }) =>
  Number((await ctx.client.query<{ n: string }>("SELECT count(*) AS n FROM session")).rows[0]?.n);

/** A refused callback sends the browser back into the app with the code. */
function refusal(res: Response): { error: string | null; until: string | null } {
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  expect(location.protocol).toBe("kuutti:");
  return { error: location.searchParams.get("error"), until: location.searchParams.get("until") };
}

/**
 * What a callback left of an attempt: its outcome, and whether its expiry
 * has come (against the clock, since now() is the test transaction's start).
 */
async function attemptOf(ctx: { client: Queryable }, state: string) {
  // "Spent" against this process's clock, read after the callback, which is
  // the clock the API wrote expires_at with: the database's clock_timestamp()
  // can run a few milliseconds behind it and call a spent attempt live.
  const { rows } = await ctx.client.query<{ outcome: string | null; spent: boolean }>(
    "SELECT outcome, expires_at <= $2 AS spent FROM auth_request WHERE state = $1",
    [state, new Date()],
  );
  return rows[0];
}

describe("bank login", () => {
  test("A login starts with the platform recorded and the browser sent to the bank chooser", async ({
    ctx,
  }) => {
    const { app, broker } = await appWith(ctx, ADULT_HETU);
    expect((await app.request("/auth/start")).status).toBe(400);
    expect((await app.request(`/auth/start?platform=web&code_challenge=${CHALLENGE}`)).status).toBe(
      400,
    );
    const state = await start(app);
    expect(broker.started).toEqual([state]);
    const rows = await ctx.client.query(
      "SELECT platform, locale, code_challenge FROM auth_request WHERE state = $1",
      [state],
    );
    // The hash of the verifier the app keeps, which its exchange must present (ADR-027).
    expect(rows.rows[0]).toEqual({ platform: "ios", locale: "fi", code_challenge: CHALLENGE });
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

  test("A return from the bank is answered once, and a failed one is spent too", async ({
    ctx,
  }) => {
    const { app, broker } = await appWith(ctx, ADULT_HETU);
    const state = await start(app);
    expect(refusal(await callback(app, state, "broken")).error).toBe("auth_provider_error");
    // The same return again, now with a code the broker would complete (#324).
    expect(refusal(await callback(app, state)).error).toBe("auth_state_mismatch");
    expect(broker.completed).toEqual([state]);
    const created = await ctx.client.query(
      "SELECT (SELECT count(*)::int FROM identity) AS identities, (SELECT count(*)::int FROM account) AS accounts",
    );
    expect(created.rows[0]).toEqual({ identities: 0, accounts: 0 });
    // Spent at the first return, and the sweep's from then on (ADR-026 §8).
    expect(await attemptOf(ctx, state)).toEqual({ outcome: "answered", spent: true });
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
    // A code without its verifier is refused before anything is looked up (ADR-027).
    const bare = await exchangeWith(app, { code: "A".repeat(43) });
    expect(bare.status).toBe(400);
    expect(await errorCode(bare)).toBe("validation_failed");
    const unknown = await exchange(app, "A".repeat(43));
    expect(unknown.status).toBe(401);
    expect(await errorCode(unknown)).toBe("auth_code_used");
  });

  test("A code is exchanged only with the verifier of the login that asked for it", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx, ADULT_HETU);
    const refused = await unknownCodeAnswer(app);
    const state = await start(app);
    const code = await codeFrom(await callback(app, state));
    // Whoever else the link reached holds the code and not the app's verifier (RFC 8252 §8.1).
    expect(await answerOf(await exchange(app, code, OTHER_VERIFIER))).toEqual(refused);
    // Refused without being spent, and nothing opened.
    expect(await codeUsedAt(ctx, state)).toBeNull();
    expect(await sessionCount(ctx)).toBe(0);
    // The app that asked for the login still exchanges it, once.
    const own = await exchange(app, code);
    expect(own.status).toBe(200);
    expect((await own.json()).outcome).toBe("created");
    expect(await codeUsedAt(ctx, state)).not.toBeNull();
    expect(await sessionCount(ctx)).toBe(1);
    expect(await answerOf(await exchange(app, code))).toEqual(refused);
  });

  test("Without a broker the login answers 503", async ({ ctx }) => {
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: ctx.client });
    const res = await app.request(`/auth/start?platform=android&code_challenge=${CHALLENGE}`);
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe("auth_provider_error");
  });

  test("A preview's login sends the app back with auth_unavailable", async ({ ctx }) => {
    const { logger } = await captureLogger();
    const config = testConfig({ APP_ENV: "preview", PR_NUMBER: "125" });
    const app = createApp({ config, logger, db: ctx.client });
    const res = await app.request(`/auth/start?platform=android&code_challenge=${CHALLENGE}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("kuutti://auth?error=auth_unavailable");
    // A request the app could not have sent is still refused first.
    expect((await app.request(`/auth/start?platform=web&code_challenge=${CHALLENGE}`)).status).toBe(
      400,
    );
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

  /** How a first return leaves without a code; the same state then comes back with a good one. */
  type FailedReturn = {
    error: string;
    /** The code the broker is handed, "good" when absent. */
    code?: string;
    /** The bank's error in place of a code, which reaches no broker. */
    bankError?: string;
    anHourAgo?: boolean;
    hetu?: string;
    banned?: boolean;
  };
  // Every way a first return can leave without a code (#324, ADR-026 §8).
  const failedReturns: Array<[string, FailedReturn]> = [
    ["the broker cannot complete", { code: "broken", error: "auth_provider_error" }],
    ["the adapter refuses", { code: "refused", error: "auth_provider_error" }],
    ["the broker fails with no Error at all", { code: "garbage", error: "auth_provider_error" }],
    ["brings the bank's error", { bankError: "server_error", error: "auth_provider_error" }],
    [
      "reports an authentication from before the attempt",
      { anHourAgo: true, error: "auth_provider_error" },
    ],
    ["brings an invalid identity code", { hetu: "010190-123B", error: "auth_provider_error" }],
    ["brings a minor", { hetu: MINOR_HETU, error: "auth_under_18" }],
    ["brings a banned identity", { banned: true, error: "auth_banned" }],
  ];
  test.for(failedReturns)(
    "a callback that %s spends its attempt: the same state again is refused without asking the bank",
    async ([, first], { ctx }) => {
      const { app, broker } = await appWith(
        ctx,
        first.hetu ?? ADULT_HETU,
        first.anHourAgo ? { authenticatedAt: new Date(Date.now() - 60 * 60_000) } : {},
      );
      if (first.banned) {
        const { hetuHmac } = deriveIdentity(ADULT_HETU, hmacKeyFromHex(KEY_HEX), NOW);
        await ctx.client.query("INSERT INTO identity (hetu_hmac, standing) VALUES ($1, 'banned')", [
          hetuHmac,
        ]);
      }
      const state = await start(app);
      const back = first.bankError
        ? await app.request(
            `/auth/callback?error=${first.bankError}&state=${encodeURIComponent(state)}`,
          )
        : await callback(app, state, first.code);
      expect(refusal(back).error).toBe(first.error);
      // The bank's own error reaches no broker; every other return asks it once.
      const asked = [...broker.completed];
      expect(asked).toEqual(first.bankError ? [] : [state]);

      expect(refusal(await callback(app, state)).error).toBe("auth_state_mismatch");
      expect(broker.completed).toEqual(asked);
      expect(await attemptOf(ctx, state)).toEqual({ outcome: "answered", spent: true });
      // Nothing created, and a refused identity counted once for the one bank login.
      const { rows } = await ctx.client.query(
        `SELECT (SELECT count(*)::int FROM account) AS accounts,
                (SELECT coalesce(sum(refused_attempts), 0)::int FROM identity) AS refused`,
      );
      expect(rows[0]).toEqual({ accounts: 0, refused: first.banned ? 1 : 0 });
    },
  );

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

  test("A failure after the attempt is claimed is a 500 the error sink sees, and the claim holds until its deadline", async ({
    ctx,
  }) => {
    const { logger, lines } = await captureLogger();
    const reported: unknown[] = [];
    const broker = fakeBroker(ADULT_HETU);
    // The connection drops at the identity's insert: after the claim and the
    // bank's answer, before anything is written.
    const db = interleaved(ctx.client, { before: /^INSERT INTO identity \(hetu_hmac/ }, () =>
      Promise.reject(new Error("connection terminated unexpectedly")),
    );
    const app = createApp({
      config: testConfig({ HETU_HMAC_KEY: KEY_HEX }),
      logger,
      db,
      broker,
      report: (error) => reported.push(error),
    });
    const state = await start(app);
    const before = Date.now();
    const res = await callback(app, state);
    const after = Date.now();
    expect(db.ran()).toBe(true);
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
    expect(await errorCode(res)).toBe("internal_error");
    expect(reported).toHaveLength(1);
    expect(lines().filter((l) => l.msg === "unhandled error")).toHaveLength(1);
    // Not ended at once as a refusal is: the claim's deadline bounds the row
    // (ADR-026 §8), and the state is spent all the same.
    const { rows } = await ctx.client.query<{ outcome: string | null; expires_at: Date }>(
      "SELECT outcome, expires_at FROM auth_request WHERE state = $1",
      [state],
    );
    expect(rows[0]?.outcome).toBe("answered");
    const deadline = rows[0]?.expires_at.getTime() ?? 0;
    expect(deadline).toBeGreaterThanOrEqual(before + AUTH_REQUEST_TTL_MS);
    expect(deadline).toBeLessThanOrEqual(after + AUTH_REQUEST_TTL_MS);
    expect(refusal(await callback(app, state)).error).toBe("auth_state_mismatch");
    expect(broker.completed).toEqual([state]);
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
    const res = await app.request(`/auth/start?platform=ios&code_challenge=${CHALLENGE}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("kuutti://auth?error=auth_unavailable");
    expect(broker.started).toEqual([]);
  });

  test("The start refuses a language the bank chooser does not have", async ({ ctx }) => {
    const { app, broker } = await appWith(ctx, ADULT_HETU);
    const res = await app.request(`/auth/start?platform=ios&locale=de&code_challenge=${CHALLENGE}`);
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

  test("The exchange takes exactly the code and its verifier, and nothing else", async ({
    ctx,
  }) => {
    const { app, state, code } = await loggedIn(ctx);
    for (const body of [
      {},
      { code },
      { verifier: VERIFIER },
      { code, verifier: VERIFIER, extra: true },
      { code: 42, verifier: VERIFIER },
      { code, verifier: 42 },
      { code, verifier: "short" },
      // The right verifier, but not as the contract writes it (ADR-027): no other spelling is taken.
      { code, verifier: VERIFIER.toUpperCase() },
      { code, verifier: `${VERIFIER}0` },
      { code, verifier: Buffer.from(VERIFIER, "hex").toString("base64url") },
    ]) {
      const res = await exchangeWith(app, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await errorCode(res)).toBe("validation_failed");
    }
    // None of the refused bodies spent the code.
    expect(await codeUsedAt(ctx, state)).toBeNull();
    expect((await exchange(app, code)).status).toBe(200);
  });

  test("The device is named by its user agent, cut to two hundred characters, or by nothing", async ({
    ctx,
  }) => {
    const first = await loggedIn(ctx);
    const res = await first.app.request("/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `Kuutti/1 ${"x".repeat(300)}` },
      body: JSON.stringify({ code: first.code, verifier: VERIFIER }),
    });
    expect(res.status).toBe(200);
    const long = (await res.json()) as { sessionId: string };
    const second = await loggedIn(ctx);
    const bare = await second.app.request("/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: second.code, verifier: VERIFIER }),
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

const startFrom = (
  app: ReturnType<typeof createApp>,
  address: string,
  query = `platform=ios&code_challenge=${CHALLENGE}`,
) => app.request(`/auth/start?${query}`, { headers: from(address) });

const exchangeFrom = (app: ReturnType<typeof createApp>, address: string, code: string) =>
  app.request("/auth/exchange", {
    method: "POST",
    headers: { ...from(address), "content-type": "application/json" },
    body: JSON.stringify({ code, verifier: VERIFIER }),
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
    expect((await startFrom(app, HERE, `platform=web&code_challenge=${CHALLENGE}`)).status).toBe(
      400,
    );
    expect(
      (await startFrom(app, HERE, `platform=ios&locale=de&code_challenge=${CHALLENGE}`)).status,
    ).toBe(400);
    expect(sentTo(await startFrom(app, HERE))).toBe("kuutti://auth?error=auth_rate_limited");
    // The doors stand before the validation: past the window nothing is read.
    expect(sentTo(await startFrom(app, HERE, `platform=web&code_challenge=${CHALLENGE}`))).toBe(
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
    start: () =>
      startLogin(deps, { platform: "ios", locale: null, codeChallenge: CHALLENGE }, SMALL_CAP),
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
    // The evicting insert binds its attempt too (ADR-027 §2): a login started
    // at the cap can still be exchanged with its verifier.
    const bound = await ctx.client.query(
      "SELECT code_challenge FROM auth_request WHERE state = $1",
      broker.started,
    );
    expect(bound.rows).toEqual([{ code_challenge: CHALLENGE }]);
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

  test("an attempt whose callback is under way is never ended to make room, however old", async ({
    ctx,
  }) => {
    await fillTo(ctx, SMALL_CAP);
    // The two oldest are back from the bank, and the broker is still
    // answering their callbacks, which claimed them (ADR-026 §8) before the
    // others started, so their deadlines still come first.
    await ctx.client.query(
      "UPDATE auth_request SET outcome = 'answered' WHERE state IN ('full-1', 'full-2')",
    );
    const { broker, logs, start } = await starter(ctx.client);
    await start();
    expect(broker.started).toHaveLength(1);
    expect(await states(ctx)).toEqual(["full-1", "full-2", "full-5", ...broker.started]);
    expect(refusedLines(logs)).toEqual([
      expect.objectContaining({ detail: { limiter: "evicted", evicted: 2 } }),
    ]);
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

  test("a refused callback's attempt is the sweep's, so it makes room before any eviction", async ({
    ctx,
  }) => {
    await fillTo(ctx, SMALL_CAP - 1);
    // The youngest attempt fills the table, comes back from the bank, and the
    // broker cannot complete it: its callback ends it there and then.
    const { app } = await appWith(ctx, ADULT_HETU);
    expect(refusal(await callback(app, await start(app), "broken")).error).toBe(
      "auth_provider_error",
    );
    expect(await attempts(ctx)).toBe(SMALL_CAP);
    const atTheCap = await starter(ctx.client);
    await atTheCap.start();
    expect(await states(ctx)).toEqual([
      "full-1",
      "full-2",
      "full-3",
      "full-4",
      ...atTheCap.broker.started,
    ]);
    // Nothing unanswered and open had to go.
    expect(refusedLines(atTheCap.logs)).toEqual([]);
  });

  test("At the table's cap a login is refused only when every attempt is back from the bank", async ({
    ctx,
  }) => {
    // The routes' own ceiling, every row of it a code waiting for its
    // exchange but one, whose callback is under way: nobody keeps such
    // a row without the bank, since a callback the bank does not complete
    // ends its attempt at once (ADR-026 §8).
    await fillTo(ctx, AUTH_REQUEST_CAP, { coded: true });
    await ctx.client.query(
      `UPDATE auth_request SET code_hash = NULL, code_expires_at = NULL, outcome = 'answered',
         expires_at = now() + interval '10 minutes'
       WHERE state = 'full-1'`,
    );
    const { app, broker, logs } = await appWith(ctx, ADULT_HETU);
    const refused = await app.request(`/auth/start?platform=ios&code_challenge=${CHALLENGE}`);
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
        codeChallenge: null,
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

// The code bound to the attempt that asked for it (#186, ADR-027): the app
// starts with the SHA-256 of a verifier it keeps, and only that verifier
// exchanges the code, so another app the deep link reaches holds a code it
// cannot spend.
describe("the code bound to the attempt that asked for it (ADR-027)", () => {
  test("a start without its code challenge, or with one that is not one lowercase hex SHA-256, is refused before anything is written", async ({
    ctx,
  }) => {
    const { app, broker } = await appWith(ctx, ADULT_HETU);
    for (const challenge of [
      "",
      "&code_challenge=",
      `&code_challenge=${CHALLENGE.toUpperCase()}`,
      `&code_challenge=${CHALLENGE.slice(1)}`,
      `&code_challenge=${CHALLENGE}0`,
      // RFC 7636's S256 as base64url: the same hash, not as the contract writes it.
      `&code_challenge=${Buffer.from(CHALLENGE, "hex").toString("base64url")}`,
      // Two of them, so that no attempt is bound to either.
      `&code_challenge=${CHALLENGE}&code_challenge=${OTHER_CHALLENGE}`,
    ]) {
      const res = await app.request(`/auth/start?platform=ios&locale=fi${challenge}`);
      expect(res.status, challenge).toBe(400);
      expect(await errorCode(res), challenge).toBe("validation_failed");
    }
    expect(broker.started).toEqual([]);
    expect(await attempts(ctx)).toBe(0);
  });

  test("of two starts each code goes only with its own attempt's verifier, so the app, which keeps the last start's, exchanges only the last one's code", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx, ADULT_HETU);
    const refused = await unknownCodeAnswer(app);
    // The person tapped twice: the app kept the second start's verifier (ADR-027, the last start wins).
    const older = await start(app, OTHER_CHALLENGE);
    const newer = await start(app);
    const olderCode = await codeFrom(await callback(app, older));
    const newerCode = await codeFrom(await callback(app, newer));
    // The older browser tab's code, with the verifier the app kept, and the other way round.
    expect(await answerOf(await exchange(app, olderCode))).toEqual(refused);
    expect(await answerOf(await exchange(app, newerCode, OTHER_VERIFIER))).toEqual(refused);
    expect(await codeUsedAt(ctx, older)).toBeNull();
    expect(await codeUsedAt(ctx, newer)).toBeNull();
    expect((await exchange(app, newerCode)).status).toBe(200);
    // Each attempt is bound to its own verifier, not to whichever start came last.
    expect((await exchange(app, olderCode, OTHER_VERIFIER)).status).toBe(200);
    expect(await sessionCount(ctx)).toBe(2);
  });

  test("an app attempt without a challenge, as one under way when the binding was deployed, is refused with any verifier", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx, ADULT_HETU);
    const refused = await unknownCodeAnswer(app);
    const state = await start(app);
    const code = await codeFrom(await callback(app, state));
    // As a row written before the column was: NULL, which no verifier's hash equals.
    await ctx.client.query("UPDATE auth_request SET code_challenge = NULL WHERE state = $1", [
      state,
    ]);
    for (const verifier of [VERIFIER, OTHER_VERIFIER]) {
      expect(await answerOf(await exchange(app, code, verifier))).toEqual(refused);
    }
    expect(await codeUsedAt(ctx, state)).toBeNull();
    expect(await sessionCount(ctx)).toBe(0);
  });

  test("a staff attempt carries no challenge: its code is refused at the app's exchange with any verifier, and the panel's exchange takes the code alone as before", async ({
    ctx,
  }) => {
    const { hetuHmac } = deriveIdentity(ADULT_HETU, hmacKeyFromHex(KEY_HEX), NOW);
    const identity = await ctx.client.query<{ id: string }>(
      "INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id",
      [hetuHmac],
    );
    await ctx.client.query(
      "INSERT INTO moderator_roles (identity_id, role, granted_by) VALUES ($1, 'moderator', 'test')",
      [identity.rows[0]?.id],
    );
    const { app } = await appWith(ctx, ADULT_HETU);
    const refused = await unknownCodeAnswer(app);
    const started = await app.request("/admin/auth/start");
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    // The panel's code returns to its own https origin, so nothing binds it (ADR-027).
    const attempt = await ctx.client.query(
      "SELECT platform, code_challenge FROM auth_request WHERE state = $1",
      [state],
    );
    expect(attempt.rows).toEqual([{ platform: "admin", code_challenge: null }]);
    const back = await callback(app, state);
    expect(back.status).toBe(302);
    const code =
      new URLSearchParams(new URL(back.headers.get("location") ?? "").hash.slice(1)).get("code") ??
      "";
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const verifier of [VERIFIER, OTHER_VERIFIER]) {
      expect(await answerOf(await exchange(app, code, verifier))).toEqual(refused);
    }
    expect(await codeUsedAt(ctx, state)).toBeNull();
    const panel = (body: unknown) =>
      app.request("/admin/auth/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    // The panel's contract has no verifier and takes none.
    const withVerifier = await panel({ code, verifier: VERIFIER });
    expect(withVerifier.status).toBe(400);
    expect(await errorCode(withVerifier)).toBe("validation_failed");
    expect((await panel({ code })).status).toBe(200);
  });

  // The app's exchange finds its code and spends it in one statement (repo.ts consumeAppCode).
  const SPENDS = /^UPDATE auth_request SET code_used_at/;

  test.for([
    ["before", { before: SPENDS }],
    ["after", { after: SPENDS }],
  ] as const)(
    "an exchange with a wrong verifier that runs whole just %s the app's own spends nothing: the app's opens the one session and the other is refused",
    async ([, at], { ctx }) => {
      let code = "";
      const others: Response[] = [];
      const db = interleaved(ctx.client, at, async () => {
        others.push(await exchange(app, code, OTHER_VERIFIER));
      });
      const { app } = await appWith({ client: db }, ADULT_HETU);
      const state = await start(app);
      code = await codeFrom(await callback(app, state));
      const own = await exchange(app, code);
      expect(db.ran()).toBe(true);
      expect(own.status).toBe(200);
      expect(others).toHaveLength(1);
      expect(await answerOf(others[0] as Response)).toEqual(await unknownCodeAnswer(app));
      expect(await codeUsedAt(ctx, state)).not.toBeNull();
      expect(await sessionCount(ctx)).toBe(1);
    },
  );

  test("two exchanges of one code with its verifier at once open one session: the one that spends it first gets it, the other the answer of an unknown code", async ({
    ctx,
  }) => {
    let code = "";
    const others: Response[] = [];
    const db = interleaved(ctx.client, { before: SPENDS }, async () => {
      others.push(await exchange(app, code));
    });
    const { app } = await appWith({ client: db }, ADULT_HETU);
    code = await codeFrom(await callback(app, await start(app)));
    const late = await exchange(app, code);
    expect(db.ran()).toBe(true);
    expect(others.map((res) => res.status)).toEqual([200]);
    expect(await answerOf(late)).toEqual(await unknownCodeAnswer(app));
    expect(await sessionCount(ctx)).toBe(1);
  });
});
