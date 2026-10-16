import type { Queryable } from "@kuutti/db";
import { ErrorResponse, OnboardingStatus } from "@kuutti/schema";
import { generateHetu } from "@kuutti/tunnistus-oidc/hetu";
import type { QueryResultRow } from "pg";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { signedInAccount, signInAs } from "../test/account.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { people, pondNamed } from "../test/people.ts";
import { deriveArtificialIdentity, registerArtificial } from "./artificial.ts";
import type { BrokerIdentity, IdentityBroker } from "./broker.ts";
import { eraseAccount } from "./erasure.ts";
import { deriveIdentity, hmacKeyFromHex } from "./hetu.ts";
import { startLogin } from "./login.ts";
import { CURRENT_CONSENT_VERSIONS } from "./onboarding.ts";

// What the slice answers when another request commits in the middle of one
// (#33, #51, #146). Every statement runs on the real database; `interleaved`
// only chooses the moment at which the other request's statements run, on the
// same rolled-back transaction, so the race comes out the same on every run.

/**
 * The test's transaction with another request's work slipped in once: just
 * before (or after) the first statement matching the pattern, `other` runs,
 * as if a concurrent request had committed at that point. `ran` says whether
 * the moment came, so a test cannot pass by missing it.
 */
function interleaved(
  db: Queryable,
  at: { before?: RegExp; after?: RegExp },
  other: () => Promise<unknown>,
): Queryable & { ran: () => boolean } {
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

/** The session guard's lookup (lib/auth-middleware.ts through the slice's session store). */
const GUARD_LOOKUP = /FROM session s JOIN account a ON a\.id = s\.account_id/;

const KEY_HEX = "ef".repeat(32);
const NOW = new Date("2026-10-01T12:00:00Z");

function rngFrom(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}
const HETU = generateHetu(rngFrom(23), { at: NOW, minAge: 30, maxAge: 45 });
const HMAC = deriveIdentity(HETU, hmacKeyFromHex(KEY_HEX), NOW).hetuHmac;

/** The bank's answer for HETU; `whileAnswering` runs while the token call is in flight. */
function broker(whileAnswering?: () => Promise<unknown>): IdentityBroker {
  return {
    issuer: "https://broker.test/uas",
    async startLogin(input) {
      const url = new URL("https://broker.test/uas/oauth2/authorization");
      url.searchParams.set("state", input.state);
      return url;
    },
    async completeLogin(): Promise<BrokerIdentity> {
      await whileAnswering?.();
      return {
        hetu: HETU,
        subject: "THIS-DEVICE",
        sessionIndex: null,
        tokenId: null,
        authenticatedAt: new Date(),
        acr: "http://ftn.ficora.fi/2017/loatest2",
        amr: [],
      };
    },
  };
}

async function appOn(
  db: Queryable,
  options: { bank?: boolean; whileTheBankAnswers?: () => Promise<unknown> } = {},
) {
  const { logger, lines } = await captureLogger();
  const config = options.bank ? testConfig({ HETU_HMAC_KEY: KEY_HEX }) : testConfig();
  const app = createApp({
    config,
    logger,
    db,
    ...(options.bank ? { broker: broker(options.whileTheBankAnswers) } : {}),
  });
  return { app, logs: lines };
}

/** The real erasure of the account, as the person's other device would run it. */
async function eraseOnOtherDevice(ctx: TestContext, accountId: string) {
  const { logger } = await captureLogger();
  await eraseAccount({ db: ctx.client, logger, now: () => new Date() }, accountId);
}

async function errorCode(res: Response): Promise<string> {
  return ErrorResponse.parse(await res.json()).error.code;
}

type Call = { method: string; path: string; body?: unknown };
const send = (app: ReturnType<typeof createApp>, headers: Record<string, string>, call: Call) =>
  app.request(call.path, {
    method: call.method,
    headers: { ...headers, "content-type": "application/json" },
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  });

async function accountRow(ctx: TestContext, accountId: string) {
  const { rows } = await ctx.client.query<{
    state: string;
    email: string | null;
    gender: string | null;
    pond_id: string | null;
  }>("SELECT state, email, gender, pond_id FROM account WHERE id = $1", [accountId]);
  return rows[0];
}

describe("an erasure that commits between the session guard and the handler", () => {
  test("the e-mail routes and the deletion answer 404 and write nothing for the tombstone", async ({
    ctx,
  }) => {
    const calls: Call[] = [
      { method: "GET", path: "/account/email" },
      { method: "PUT", path: "/account/email", body: { email: "race.probe@example.fi" } },
      { method: "DELETE", path: "/account/email" },
      { method: "POST", path: "/account/delete", body: { confirm: true } },
    ];
    for (const call of calls) {
      const me = await signedInAccount(ctx.client);
      const db = interleaved(ctx.client, { after: GUARD_LOOKUP }, () =>
        eraseOnOtherDevice(ctx, me.accountId),
      );
      const { app, logs } = await appOn(db);
      const res = await send(app, me.headers, call);
      const label = `${call.method} ${call.path}`;
      expect(db.ran(), label).toBe(true);
      expect(res.status, label).toBe(404);
      expect(await errorCode(res), label).toBe("not_found");
      expect(await accountRow(ctx, me.accountId), label).toMatchObject({
        state: "deleted",
        email: null,
      });
      // The handler's own success lines never appear: nothing was set, cleared or erased twice.
      expect(
        logs().filter((l) =>
          ["email set", "email cleared", "account erased"].includes(l.msg ?? ""),
        ),
        label,
      ).toEqual([]);
      const { rows } = await ctx.client.query<{ deletion_count: number }>(
        "SELECT i.deletion_count FROM identity i JOIN account a ON a.identity_id = i.id WHERE a.id = $1",
        [me.accountId],
      );
      expect(rows[0]?.deletion_count, label).toBe(1);
    }
  });

  test("the onboarding, gender and consent routes answer 404 and write nothing for the tombstone", async ({
    ctx,
  }) => {
    const research = {
      kind: "research",
      version: CURRENT_CONSENT_VERSIONS.research,
      locale: "fi",
    };
    const calls: Array<Call & { given?: boolean }> = [
      { method: "GET", path: "/onboarding" },
      { method: "PUT", path: "/account/gender", body: { gender: "woman" } },
      { method: "POST", path: "/consents", body: research },
      // A research consent given before, which the losing withdrawal must leave as it was.
      { method: "DELETE", path: "/consents/research", given: true },
    ];
    for (const call of calls) {
      const me = await signedInAccount(ctx.client, undefined, { state: "registered" });
      if (call.given) {
        const plain = await appOn(ctx.client);
        expect(
          (await send(plain.app, me.headers, { method: "POST", path: "/consents", body: research }))
            .status,
        ).toBe(200);
      }
      const db = interleaved(ctx.client, { after: GUARD_LOOKUP }, () =>
        eraseOnOtherDevice(ctx, me.accountId),
      );
      const { app, logs } = await appOn(db);
      const res = await send(app, me.headers, call);
      const label = `${call.method} ${call.path}`;
      expect(db.ran(), label).toBe(true);
      expect(res.status, label).toBe(404);
      expect(await errorCode(res), label).toBe("not_found");
      expect(await accountRow(ctx, me.accountId), label).toMatchObject({
        state: "deleted",
        gender: null,
        pond_id: null,
      });
      const consents = await ctx.client.query<{ withdrawn: boolean }>(
        "SELECT withdrawn_at IS NOT NULL AS withdrawn FROM consent WHERE account_id = $1 AND kind = 'research'",
        [me.accountId],
      );
      // No consent recorded for the tombstone; the one given before went with the
      // account (ADR-010 §14), so the losing withdrawal had nothing to touch either.
      expect(consents.rows, label).toEqual([]);
      expect(
        logs().filter((l) =>
          ["gender declared", "consent given", "consent withdrawn", "pond assigned"].includes(
            l.msg ?? "",
          ),
        ),
        label,
      ).toEqual([]);
    }
  });

  test("a second deletion that loses the race to the first answers 404 and erases nothing itself", async ({
    ctx,
  }) => {
    const me = await signedInAccount(ctx.client);
    // The first deletion commits after this one has locked the row and found it live.
    const db = interleaved(
      ctx.client,
      { after: /SELECT state FROM account WHERE id = \$1 FOR UPDATE/ },
      () => eraseOnOtherDevice(ctx, me.accountId),
    );
    const { app, logs } = await appOn(db);
    const res = await send(app, me.headers, {
      method: "POST",
      path: "/account/delete",
      body: { confirm: true },
    });
    expect(db.ran()).toBe(true);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
    expect(logs().filter((l) => l.msg === "account erased")).toEqual([]);
  });
});

describe("the status read racing another request", () => {
  /** A registered account with every answer activation waits for (#146): only the profile steps are open. */
  async function readyToActivate(ctx: TestContext) {
    const pondId = await pondNamed(ctx.client, `race-${Math.floor(NOW.getTime() / 1000)}`);
    const [accountId = ""] = await people(ctx.client, pondId, 1, {
      state: "registered",
      gender: "woman",
      consented: true,
    });
    await ctx.client.query(
      `INSERT INTO preferences (account_id, field, value, mode, include_unknown)
       VALUES ($1, 'seeks', '["man"]', 'hard', false), ($1, 'age_window', '{"min":25,"max":40}', 'hard', false)`,
      [accountId],
    );
    return signInAs(ctx.client, accountId);
  }

  // The activation's own statement (it chooses shadow_banned under an open shadow ban, ADR-024 §2).
  const ACTIVATE = /UPDATE account SET state_changed_at = \$2,\s+state = CASE/;

  test("two status reads at once activate the account once and both answer active", async ({
    ctx,
  }) => {
    const me = await readyToActivate(ctx);
    // The other read's activation commits just before this one's.
    const db = interleaved(ctx.client, { before: ACTIVATE }, () =>
      ctx.client.query(
        "UPDATE account SET state = 'active', state_changed_at = now() WHERE id = $1 AND state = 'registered'",
        [me.accountId],
      ),
    );
    const { app, logs } = await appOn(db);
    const res = await app.request("/onboarding", { headers: me.headers });
    expect(db.ran()).toBe(true);
    expect(res.status).toBe(200);
    const status = OnboardingStatus.parse(await res.json());
    expect(status.state).toBe("active");
    expect(status.missing).toEqual(["name", "intent", "photos", "prompts_or_bio"]);
    // The activation was the other read's: this one leaves no line of its own.
    expect(logs().filter((l) => l.msg === "account activated")).toEqual([]);
    expect((await accountRow(ctx, me.accountId))?.state).toBe("active");
  });

  test("an erasure just before the activation activates nothing and answers with the state it read", async ({
    ctx,
  }) => {
    const me = await readyToActivate(ctx);
    const db = interleaved(ctx.client, { before: ACTIVATE }, () =>
      eraseOnOtherDevice(ctx, me.accountId),
    );
    const { app, logs } = await appOn(db);
    const res = await app.request("/onboarding", { headers: me.headers });
    expect(db.ran()).toBe(true);
    expect(res.status).toBe(200);
    expect(OnboardingStatus.parse(await res.json()).state).toBe("registered");
    expect(logs().filter((l) => l.msg === "account activated")).toEqual([]);
    expect((await accountRow(ctx, me.accountId))?.state).toBe("deleted");
  });

  test("an erasure just before the default pond is assigned puts no pond on the tombstone", async ({
    ctx,
  }) => {
    // The one-pond world the default pond needs (ADR-010 §12), as onboarding.test.ts builds it.
    await ctx.client.query("DELETE FROM ponds WHERE slug = 'suomi'");
    await ctx.client.query(
      "INSERT INTO ponds (slug, name_nominative, name_inessive) VALUES ('paakaupunkiseutu', 'Pääkaupunkiseutu', 'Pääkaupunkiseudulla') ON CONFLICT (slug) DO NOTHING",
    );
    const me = await signedInAccount(ctx.client, undefined, { state: "registered" });
    const db = interleaved(ctx.client, { before: /UPDATE account SET pond_id = \$2/ }, () =>
      eraseOnOtherDevice(ctx, me.accountId),
    );
    const { app, logs } = await appOn(db);
    const res = await app.request("/onboarding", { headers: me.headers });
    expect(db.ran()).toBe(true);
    expect(res.status).toBe(200);
    const status = OnboardingStatus.parse(await res.json());
    expect(status.pond).toBeNull();
    expect(status.missing).toContain("pond");
    expect(logs().filter((l) => l.msg === "pond assigned")).toEqual([]);
    expect(await accountRow(ctx, me.accountId)).toMatchObject({ state: "deleted", pond_id: null });
  });
});

describe("a bank login racing another request", () => {
  async function start(app: ReturnType<typeof createApp>) {
    const res = await app.request("/auth/start?platform=ios&locale=fi");
    expect(res.status).toBe(302);
    return new URL(res.headers.get("location") ?? "").searchParams.get("state") ?? "";
  }

  test("two first logins of the same person at once leave one identity and one account, and the later one resumes it", async ({
    ctx,
  }) => {
    let otherAccount = "";
    // The other device's first login commits its identity and account just before this one inserts.
    const db = interleaved(
      ctx.client,
      { before: /INSERT INTO identity \(hetu_hmac, broker_subject, broker_session_index/ },
      async () => {
        const identity = await ctx.client.query<{ id: string }>(
          "INSERT INTO identity (hetu_hmac, broker_subject) VALUES ($1, 'OTHER-DEVICE') RETURNING id",
          [HMAC],
        );
        const account = await ctx.client.query<{ id: string }>(
          "INSERT INTO account (identity_id, state, birth_year, birth_month) VALUES ($1, 'registered', 1985, 3) RETURNING id",
          [identity.rows[0]?.id],
        );
        otherAccount = account.rows[0]?.id ?? "";
      },
    );
    const { app, logs } = await appOn(db, { bank: true });
    const state = await start(app);
    const back = await app.request(`/auth/callback?code=ok&state=${encodeURIComponent(state)}`);
    expect(db.ran()).toBe(true);
    expect(back.status).toBe(302);
    const code = new URL(back.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const exchanged = await app.request("/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(exchanged.status).toBe(200);
    const body = (await exchanged.json()) as { outcome: string; accessToken: string };
    expect(body.outcome).toBe("resumed");
    const me = await app.request("/auth/session", {
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(((await me.json()) as { accountId: string }).accountId).toBe(otherAccount);
    const { rows } = await ctx.client.query<{ subject: string; accounts: string }>(
      `SELECT i.broker_subject AS subject, (SELECT count(*) FROM account a WHERE a.identity_id = i.id) AS accounts
       FROM identity i WHERE i.hetu_hmac = $1`,
      [HMAC],
    );
    // One identity, one account, and the identity carries this login's reference.
    expect(rows).toEqual([{ subject: "THIS-DEVICE", accounts: "1" }]);
    expect(logs().find((l) => l.msg === "bank login")).toMatchObject({ outcome: "resumed" });
  });

  test("an erasure between the login's decision and its code sends the browser back with the cooldown", async ({
    ctx,
  }) => {
    // The person has an account; the login resumes it while their other device erases it.
    const identity = await ctx.client.query<{ id: string }>(
      "INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id",
      [HMAC],
    );
    const identityId = identity.rows[0]?.id ?? "";
    const account = await ctx.client.query<{ id: string }>(
      "INSERT INTO account (identity_id, state, birth_year, birth_month) VALUES ($1, 'active', 1985, 3) RETURNING id",
      [identityId],
    );
    const accountId = account.rows[0]?.id ?? "";
    const db = interleaved(
      ctx.client,
      { before: /SET code_hash = \$2, code_expires_at = \$3, account_id = \$4/ },
      () => eraseOnOtherDevice(ctx, accountId),
    );
    const { app } = await appOn(db, { bank: true });
    const state = await start(app);
    const back = await app.request(`/auth/callback?code=ok&state=${encodeURIComponent(state)}`);
    expect(db.ran()).toBe(true);
    expect(back.status).toBe(302);
    const location = new URL(back.headers.get("location") ?? "");
    expect(location.protocol).toBe("kuutti:");
    expect(location.searchParams.get("code")).toBeNull();
    expect(location.searchParams.get("error")).toBe("auth_cooldown");
    const { rows } = await ctx.client.query<{
      until: Date;
      refused: number;
      accounts: string;
    }>(
      `SELECT reregister_after AS until, refused_attempts AS refused,
              (SELECT count(*) FROM account WHERE identity_id = $1 AND state <> 'deleted') AS accounts
       FROM identity WHERE id = $1`,
      [identityId],
    );
    expect(location.searchParams.get("until")).toBe(rows[0]?.until.toISOString());
    expect(rows[0]).toMatchObject({ refused: 1, accounts: "0" });
    // No code was published for the erased account, nor for anyone.
    const attempt = await ctx.client.query(
      "SELECT code_hash, account_id FROM auth_request WHERE state = $1",
      [state],
    );
    expect(attempt.rows).toEqual([{ code_hash: null, account_id: null }]);
  });

  test("an erasure between the code's use and the session opens no session for the tombstone", async ({
    ctx,
  }) => {
    let state = "";
    let accountId = "";
    // The code is spent; the erasure commits before the session row is written.
    const db = interleaved(
      ctx.client,
      { after: /UPDATE auth_request SET code_used_at/ },
      async () => {
        const { rows } = await ctx.client.query<{ account_id: string }>(
          "SELECT account_id FROM auth_request WHERE state = $1",
          [state],
        );
        accountId = rows[0]?.account_id ?? "";
        await eraseOnOtherDevice(ctx, accountId);
      },
    );
    const { app } = await appOn(db, { bank: true });
    state = await start(app);
    const back = await app.request(`/auth/callback?code=ok&state=${encodeURIComponent(state)}`);
    const code = new URL(back.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const res = await app.request("/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(db.ran()).toBe(true);
    // The code reads as spent: the person signs in again once the cooldown has passed.
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("auth_code_used");
    const sessions = await ctx.client.query(
      "SELECT count(*) AS n FROM session WHERE account_id = $1",
      [accountId],
    );
    expect(Number(sessions.rows[0]?.n)).toBe(0);
    expect((await accountRow(ctx, accountId))?.state).toBe("deleted");
  });

  /**
   * Somebody else's start at the ceiling (ADR-026 §6), committed: the table is
   * full, so it ends the oldest attempts the bank has not answered, this
   * login's among them, and takes the room.
   */
  async function startAtTheCeiling(ctx: TestContext) {
    const { logger } = await captureLogger();
    const { rows } = await ctx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth_request",
    );
    const deps = {
      db: ctx.client,
      broker: broker(),
      hmacKey: hmacKeyFromHex(KEY_HEX),
      now: () => new Date(),
      logger,
      adminAppUrl: "http://localhost:5173",
    };
    await startLogin(deps, { platform: "ios", locale: null }, rows[0]?.n ?? 0);
  }

  /** Where the callback sent the browser, after checking it is no 500. */
  async function callbackTo(app: ReturnType<typeof createApp>, state: string) {
    const back = await app.request(`/auth/callback?code=ok&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(302);
    return new URL(back.headers.get("location") ?? "");
  }

  const attemptRows = async (ctx: TestContext, state: string) =>
    (await ctx.client.query("SELECT 1 FROM auth_request WHERE state = $1", [state])).rows.length;

  /** Error lines: a 500 leaves one, a refusal does not. */
  const errorLines = (logs: () => Array<{ level?: number }>) =>
    logs().filter((line) => (line.level ?? 0) >= 50);

  test("an attempt ended at the ceiling while the bank answers sends a first login back with auth_state_mismatch, and nothing is created", async ({
    ctx,
  }) => {
    const { app, logs } = await appOn(ctx.client, {
      bank: true,
      whileTheBankAnswers: () => startAtTheCeiling(ctx),
    });
    const state = await start(app);
    const back = await callbackTo(app, state);
    expect(back.protocol).toBe("kuutti:");
    expect(back.searchParams.get("error")).toBe("auth_state_mismatch");
    expect(back.searchParams.get("code")).toBeNull();
    expect(await attemptRows(ctx, state)).toBe(0);
    // No identity and no account for a login whose attempt is gone: the
    // person's next login is their first.
    const { rows } = await ctx.client.query("SELECT 1 FROM identity WHERE hetu_hmac = $1", [HMAC]);
    expect(rows).toEqual([]);
    expect(logs().filter((line) => line.msg === "bank login")).toEqual([]);
    expect(errorLines(logs)).toEqual([]);
  });

  test("an attempt ended at the ceiling while the bank answers leaves a paused account paused", async ({
    ctx,
  }) => {
    const identity = await ctx.client.query<{ id: string }>(
      "INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id",
      [HMAC],
    );
    const identityId = identity.rows[0]?.id ?? "";
    const account = await ctx.client.query<{ id: string }>(
      `INSERT INTO account (identity_id, state, paused_from, birth_year, birth_month)
       VALUES ($1, 'paused', 'active', 1985, 3) RETURNING id`,
      [identityId],
    );
    const accountId = account.rows[0]?.id ?? "";
    const { app, logs } = await appOn(ctx.client, {
      bank: true,
      whileTheBankAnswers: () => startAtTheCeiling(ctx),
    });
    const back = await callbackTo(app, await start(app));
    expect(back.searchParams.get("error")).toBe("auth_state_mismatch");
    // The break goes on, and the identity keeps no reference of this login.
    expect((await accountRow(ctx, accountId))?.state).toBe("paused");
    const { rows } = await ctx.client.query<{ subject: string | null }>(
      "SELECT broker_subject AS subject FROM identity WHERE id = $1",
      [identityId],
    );
    expect(rows).toEqual([{ subject: null }]);
    expect(logs().filter((line) => line.msg === "account resumed")).toEqual([]);
    expect(errorLines(logs)).toEqual([]);
  });

  test("an attempt ended at the ceiling between the account's resolution and its code sends the browser back with auth_state_mismatch, not a 500", async ({
    ctx,
  }) => {
    const db = interleaved(
      ctx.client,
      { before: /SET code_hash = \$2, code_expires_at = \$3, account_id = \$4/ },
      () => startAtTheCeiling(ctx),
    );
    const { app, logs } = await appOn(db, { bank: true });
    const state = await start(app);
    const back = await callbackTo(app, state);
    expect(db.ran()).toBe(true);
    expect(back.protocol).toBe("kuutti:");
    expect(back.searchParams.get("error")).toBe("auth_state_mismatch");
    expect(await attemptRows(ctx, state)).toBe(0);
    // No code was published, for this login or anyone.
    const coded = await ctx.client.query(
      "SELECT 1 FROM auth_request WHERE code_hash IS NOT NULL OR account_id IS NOT NULL",
    );
    expect(coded.rows).toEqual([]);
    expect(logs().filter((line) => line.msg === "bank login")).toEqual([]);
    expect(errorLines(logs)).toEqual([]);
  });

  test("a staff attempt ended at the ceiling while the bank answers lands on the panel with auth_state_mismatch and writes nothing", async ({
    ctx,
  }) => {
    const identity = await ctx.client.query<{ id: string }>(
      "INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id",
      [HMAC],
    );
    const identityId = identity.rows[0]?.id ?? "";
    const { app, logs } = await appOn(ctx.client, {
      bank: true,
      whileTheBankAnswers: () => startAtTheCeiling(ctx),
    });
    const started = await app.request("/admin/auth/start");
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const back = await callbackTo(app, state);
    // The same answer with or without a role: the attempt is gone, which is all it says.
    expect(back.origin).toBe("http://localhost:5173");
    expect(back.hash).toBe("#error=auth_state_mismatch");
    const { rows } = await ctx.client.query<{ subject: string | null }>(
      "SELECT broker_subject AS subject FROM identity WHERE id = $1",
      [identityId],
    );
    expect(rows).toEqual([{ subject: null }]);
    expect(errorLines(logs)).toEqual([]);
  });

  test("a staff attempt ended at the ceiling between the role check and its code lands on the panel with auth_state_mismatch", async ({
    ctx,
  }) => {
    const identity = await ctx.client.query<{ id: string }>(
      "INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id",
      [HMAC],
    );
    const identityId = identity.rows[0]?.id ?? "";
    await ctx.client.query(
      "INSERT INTO moderator_roles (identity_id, role, granted_by) VALUES ($1, 'moderator', 'test')",
      [identityId],
    );
    const db = interleaved(
      ctx.client,
      { before: /SET code_hash = \$2, code_expires_at = \$3, identity_id = \$4/ },
      () => startAtTheCeiling(ctx),
    );
    const { app, logs } = await appOn(db, { bank: true });
    const started = await app.request("/admin/auth/start");
    expect(started.status).toBe(302);
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const back = await callbackTo(app, state);
    expect(db.ran()).toBe(true);
    // The panel's own error, not a code the exchange would refuse as used.
    expect(back.origin).toBe("http://localhost:5173");
    expect(back.hash).toBe("#error=auth_state_mismatch");
    expect(await attemptRows(ctx, state)).toBe(0);
    const coded = await ctx.client.query("SELECT 1 FROM auth_request WHERE identity_id = $1", [
      identityId,
    ]);
    expect(coded.rows).toEqual([]);
    expect(errorLines(logs)).toEqual([]);
  });
});

describe("an artificial registration racing another", () => {
  test("an identity written meanwhile by another run is refused, not doubled", async ({ ctx }) => {
    const key = hmacKeyFromHex(KEY_HEX);
    const hetu = "170677-924F";
    const { hetuHmac } = deriveArtificialIdentity(hetu, key, NOW);
    const db = interleaved(
      ctx.client,
      { before: /INSERT INTO identity \(hetu_hmac, broker_subject, created_at\)/ },
      () =>
        ctx.client.query("INSERT INTO identity (hetu_hmac, broker_subject) VALUES ($1, 'other')", [
          hetuHmac,
        ]),
    );
    await expect(
      registerArtificial(db, { hetu, key, subject: "test:race", now: NOW }),
    ).rejects.toThrow(/written meanwhile/);
    expect(db.ran()).toBe(true);
    const { rows } = await ctx.client.query<{ subject: string; accounts: string }>(
      `SELECT broker_subject AS subject, (SELECT count(*) FROM account a WHERE a.identity_id = i.id) AS accounts
       FROM identity i WHERE hetu_hmac = $1`,
      [hetuHmac],
    );
    expect(rows).toEqual([{ subject: "other", accounts: "0" }]);
  });
});
