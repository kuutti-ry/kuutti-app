import { generateHetu } from "@kuutti/db";
import { ErrorResponse } from "@kuutti/schema";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { captureLogger, test, testConfig } from "../test/harness.ts";
import type { BrokerIdentity, IdentityBroker } from "./broker.ts";
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
      if (input.callbackUrl.searchParams.get("code") === "broken") throw new Error("bad code");
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
});
