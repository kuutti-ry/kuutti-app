import type { Queryable } from "@kuutti/db";
import {
  AuthExchangeResponse,
  ErrorResponse,
  OnboardingStatus,
  Sanction,
  type SanctionKind,
  SessionResponse,
} from "@kuutti/schema";
import { generateHetu } from "@kuutti/tunnistus-oidc/hetu";
import type { QueryResultRow } from "pg";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { eraseAccount, type IdentityBroker } from "../identity/index.ts";
import { recordCardServed } from "../media/index.ts";
import {
  type Staff,
  signedInAccount,
  signInAs,
  staffSession,
  withMatchingConfig,
} from "../test/account.ts";
import { exportOf } from "../test/export.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { testMediaDeps } from "../test/media.ts";
import { people, pondNamed } from "../test/people.ts";
import {
  applySanction,
  deleteSanctionsOfAccount,
  endSuspensions,
  liftSanction,
  listSanctions,
  listSanctionsOfAccount,
  reviewSanction,
} from "./sanctions.ts";

// Sanctions (#307, ADR-024, features/safety/sanctions.feature): the panel's
// routes driven as staff, the person's side through the bank login, the
// guard, onboarding, the export and the photo URLs, and the service beneath
// them. Real Postgres in one rolled-back transaction per test; the routes'
// clock is fixed, races are interleaved by statement, never by sleeping.

const T = new Date("2026-10-20T09:00:00Z");
/** The start of 22.10.2026 in Finland (summer time, UTC+3). */
const START_OF_22_10 = "2026-10-21T21:00:00.000Z";
/** The night of 22.10.2026, at four in Finland. */
const NIGHT_22_10 = new Date("2026-10-22T01:00:00Z");
const TOKEN = "K7Q-3091";
const NOTE = `Sent the same opener to forty people in an hour, ticket ${TOKEN}`;
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000307";

// The bank: a broker that answers for one generated person (#33).

const KEY_HEX = "5a".repeat(32);

function rngFrom(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}
const HETU = generateHetu(rngFrom(307), {
  at: new Date("2026-10-01T12:00:00Z"),
  minAge: 28,
  maxAge: 45,
});

type BrokerAnswer = Awaited<ReturnType<IdentityBroker["completeLogin"]>>;
const bank: IdentityBroker = {
  issuer: "https://broker.test/uas",
  async startLogin(input) {
    const url = new URL("https://broker.test/uas/oauth2/authorization");
    url.searchParams.set("state", input.state);
    return url;
  },
  async completeLogin(): Promise<BrokerAnswer> {
    return {
      hetu: HETU,
      subject: "SANCTIONS-TEST-SUBJECT",
      sessionIndex: null,
      tokenId: null,
      authenticatedAt: new Date(),
      acr: "http://ftn.ficora.fi/2017/loatest2",
      amr: [],
    };
  },
};

type App = ReturnType<typeof createApp>;
type Headers = Record<string, string>;

async function appFor(ctx: TestContext, options: { db?: Queryable; media?: boolean } = {}) {
  const { logger, lines } = await captureLogger();
  const clock = { at: T };
  const app = createApp({
    config: testConfig({
      HETU_HMAC_KEY: KEY_HEX,
      OIDC_ISSUER: "https://broker.test/uas",
      OIDC_CLIENT_ID: "kuutti-test",
      OIDC_REDIRECT_URI: "https://api.test/auth/callback",
    }),
    logger,
    db: options.db ?? ctx.client,
    broker: bank,
    now: () => clock.at,
    ...(options.media ? { media: testMediaDeps().deps } : {}),
  });
  return { app, logs: lines, clock };
}

/** The bank login up to the redirect into the app: a one-time code, or the refusal and its date. */
async function bankCallback(app: App): Promise<URL> {
  const started = await app.request("/auth/start?platform=ios&locale=fi");
  expect(started.status).toBe(302);
  const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const back = await app.request(`/auth/callback?code=good&state=${encodeURIComponent(state)}`);
  expect(back.status).toBe(302);
  const location = new URL(back.headers.get("location") ?? "");
  expect(location.protocol).toBe("kuutti:");
  return location;
}

type BankSignIn = {
  outcome: AuthExchangeResponse["outcome"];
  accountId: string;
  headers: Headers;
};

async function bankLogin(app: App): Promise<BankSignIn> {
  const back = await bankCallback(app);
  const code = back.searchParams.get("code");
  if (!code) throw new Error(`the bank login was refused: ${back.searchParams.get("error")}`);
  const exchanged = await app.request("/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  expect(exchanged.status).toBe(200);
  const body = AuthExchangeResponse.parse(await exchanged.json());
  const headers = { authorization: `Bearer ${body.accessToken}` };
  const session = await app.request("/auth/session", { headers });
  expect(session.status).toBe(200);
  return {
    outcome: body.outcome,
    accountId: SessionResponse.parse(await session.json()).accountId,
    headers,
  };
}

async function refusedBankLogin(app: App) {
  const back = await bankCallback(app);
  expect(back.searchParams.get("code")).toBeNull();
  return { error: back.searchParams.get("error"), until: back.searchParams.get("until") };
}

/** The bank's person, signed in once and through onboarding (active), or still registered. */
async function bankPerson(
  ctx: TestContext,
  app: App,
  state: "active" | "registered" = "active",
): Promise<BankSignIn> {
  const first = await bankLogin(app);
  expect(first.outcome).toBe("created");
  await ctx.client.query("UPDATE account SET state = $2 WHERE id = $1", [first.accountId, state]);
  return first;
}

// The panel's routes, as a member of staff calls them.

const send = (app: App, headers: Headers, path: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const WARN = { kind: "warn", reason: "harassment", note: NOTE } as const;
const SHADOW_BAN = { kind: "shadow_ban", reason: "scraping", note: NOTE } as const;
const SUSPEND = {
  kind: "suspend",
  reason: "harassment",
  note: NOTE,
  endsOn: "2026-10-22",
} as const;
const BAN = { reason: "harassment", note: NOTE } as const;

const apply = (app: App, staff: Staff, accountId: string, body: Record<string, unknown>) =>
  send(app, staff.headers, `/admin/accounts/${accountId}/sanctions`, body);
const banOf = (app: App, staff: Staff, accountId: string) =>
  send(app, staff.headers, `/admin/accounts/${accountId}/bans`, BAN);
const liftOf = (app: App, staff: Staff, id: string, route: "sanctions" | "bans" = "sanctions") =>
  send(app, staff.headers, `/admin/${route}/${id}/lift`);
const reviewOf = (
  app: App,
  staff: Staff,
  id: string,
  body: { note: string; outcome: "keep" | "lift" },
  route: "sanctions" | "bans" = "sanctions",
) => send(app, staff.headers, `/admin/${route}/${id}/review`, body);

async function created(response: Response): Promise<Sanction> {
  expect(response.status).toBe(201);
  return Sanction.parse(await response.json());
}

async function errorCode(response: Response): Promise<string> {
  return ErrorResponse.parse(await response.json()).error.code;
}

// What the database says.

async function stateOf(ctx: TestContext, accountId: string) {
  const { rows } = await ctx.client.query<{
    state: string;
    paused_from: string | null;
    sanctioned_from: string | null;
    standing: string;
    suspension_ends_at: Date | null;
  }>(
    `SELECT a.state, a.paused_from, a.sanctioned_from, i.standing, i.suspension_ends_at
     FROM account a JOIN identity i ON i.id = a.identity_id WHERE a.id = $1`,
    [accountId],
  );
  return rows[0];
}

const ACTIVE = {
  state: "active",
  paused_from: null,
  sanctioned_from: null,
  standing: "ok",
  suspension_ends_at: null,
};

async function sanctionRow(ctx: TestContext, id: string) {
  const { rows } = await ctx.client.query<{
    lifted_at: Date | null;
    lifted_by: string | null;
    reviewed_at: Date | null;
    reviewed_by: string | null;
    review_note: string | null;
  }>(
    "SELECT lifted_at, lifted_by, reviewed_at, reviewed_by, review_note FROM sanction WHERE id = $1",
    [id],
  );
  return rows[0];
}

async function count(ctx: TestContext, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await ctx.client.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

const sanctionsOf = (ctx: TestContext, accountId: string) =>
  count(ctx, "SELECT count(*) AS n FROM sanction WHERE account_id = $1", [accountId]);

const auditCount = (ctx: TestContext, accountId: string) =>
  count(ctx, "SELECT count(*) AS n FROM audit_log WHERE subject_id = $1", [accountId]);

const auditBy = (ctx: TestContext, actors: string[]) =>
  count(ctx, "SELECT count(*) AS n FROM audit_log WHERE actor_identity_id = ANY($1::uuid[])", [
    actors,
  ]);

async function auditOf(ctx: TestContext, accountId: string) {
  const { rows } = await ctx.client.query<{
    actor_identity_id: string;
    action: string;
    subject_type: string;
    detail: Record<string, unknown>;
  }>(
    "SELECT actor_identity_id, action, subject_type, detail FROM audit_log WHERE subject_id = $1",
    [accountId],
  );
  return rows;
}

async function identityOf(ctx: TestContext, accountId: string): Promise<string> {
  const { rows } = await ctx.client.query<{ identity_id: string }>(
    "SELECT identity_id FROM account WHERE id = $1",
    [accountId],
  );
  const id = rows[0]?.identity_id;
  if (!id) throw new Error("no such account");
  return id;
}

/** An erased account, a tombstone, of the same identity as `accountId` or of a new one. */
async function tombstone(ctx: TestContext, identityId?: string): Promise<string> {
  if (!identityId) {
    const [id] = await people(ctx.client, null, 1, { state: "deleted" });
    if (!id) throw new Error("no tombstone written");
    return id;
  }
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO account (identity_id, state, deleted_at, state_changed_at)
     VALUES ($1, 'deleted', $2, $2) RETURNING id`,
    [identityId, new Date("2026-08-01T10:00:00Z")],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("no tombstone written");
  return id;
}

/** An approved photo of the account, as the moderation queue leaves it. */
async function approvedPhoto(ctx: TestContext, accountId: string): Promise<string> {
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO photo (account_id, key, blurhash, width, height, state, position)
     VALUES ($1, md5($2), 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 800, 1067, 'approved', 0)
     RETURNING id`,
    [accountId, `sanctions test photo ${accountId}`],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("no photo written");
  return id;
}

/** The input of a service call, the parts a test does not care about filled in. */
const input = (
  accountId: string,
  kind: SanctionKind,
  options: { actor?: string | null; at?: Date; endsOn?: string } = {},
) => ({
  accountId,
  kind,
  reason: "other" as const,
  note: NOTE,
  actor: options.actor ?? null,
  at: options.at ?? T,
  ...(kind === "suspend" ? { endsOn: options.endsOn ?? "2026-10-22" } : {}),
});

/**
 * The test's transaction with another request's work slipped in once, just
 * after the first statement matching `after`, as if a concurrent request had
 * committed at that moment (the pattern of identity/races.test.ts). `ran`
 * says whether the moment came, so a test cannot pass by missing it.
 */
function interleaved(
  db: Queryable,
  after: RegExp,
  other: () => Promise<unknown>,
): Queryable & { ran: () => boolean } {
  let ran = false;
  return {
    ran: () => ran,
    async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      const result = await db.query<R>(text, values);
      if (!ran && after.test(text)) {
        ran = true;
        await other();
      }
      return result;
    },
  };
}

/** The test's transaction with a look taken just before every statement matching `before`. */
function probed(db: Queryable, before: RegExp, look: () => Promise<void>): Queryable {
  return {
    async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      if (before.test(text)) await look();
      return db.query<R>(text, values);
    },
  };
}

/** The sanction read before a lift's or a review's transaction begins. */
const SANCTION_READ = /FROM sanction WHERE id = \$1/;

describe("Sanctions", () => {
  test("A ban ends every session and refuses the next bank login", async ({ ctx }) => {
    const { app } = await appFor(ctx);
    const phone = await bankPerson(ctx, app);
    const tablet = await bankLogin(app);
    expect(tablet).toMatchObject({ outcome: "resumed", accountId: phone.accountId });
    const admin = await staffSession(ctx.client, "admin");

    const ban = await created(await banOf(app, admin, phone.accountId));
    expect(ban).toMatchObject({
      accountId: phone.accountId,
      kind: "ban",
      reason: "harassment",
      endsAt: null,
      createdBy: admin.identityId,
      createdAt: T.toISOString(),
      liftedAt: null,
    });

    for (const device of [phone, tablet]) {
      const next = await app.request("/auth/session", { headers: device.headers });
      expect(next.status).toBe(401);
      expect(await errorCode(next)).toBe("session_revoked");
    }
    const { rows } = await ctx.client.query(
      "SELECT revoked_at, revoked_reason FROM session WHERE account_id = $1",
      [phone.accountId],
    );
    expect(rows).toEqual([
      { revoked_at: T, revoked_reason: "sanction" },
      { revoked_at: T, revoked_reason: "sanction" },
    ]);
    expect(await stateOf(ctx, phone.accountId)).toEqual({
      state: "banned",
      paused_from: null,
      sanctioned_from: "active",
      standing: "banned",
      suspension_ends_at: null,
    });
    expect(await refusedBankLogin(app)).toEqual({ error: "auth_banned", until: null });
  });

  test("A suspension refuses the login until its day and the night lifts it", async ({ ctx }) => {
    const { app } = await appFor(ctx);
    const a = await bankPerson(ctx, app);
    const moderator = await staffSession(ctx.client);

    const suspension = await created(await apply(app, moderator, a.accountId, SUSPEND));
    expect(suspension.endsAt).toBe(START_OF_22_10);
    expect(await stateOf(ctx, a.accountId)).toEqual({
      state: "suspended",
      paused_from: null,
      sanctioned_from: "active",
      standing: "suspended",
      suspension_ends_at: new Date(START_OF_22_10),
    });
    expect(await refusedBankLogin(app)).toEqual({ error: "auth_suspended", until: START_OF_22_10 });

    // The night of 21.10 is a day early and changes nothing.
    expect(await endSuspensions(ctx.client, new Date("2026-10-21T01:00:00Z"))).toBe(0);
    expect(await stateOf(ctx, a.accountId)).toMatchObject({ state: "suspended" });

    expect(await endSuspensions(ctx.client, NIGHT_22_10)).toBe(1);
    expect(await stateOf(ctx, a.accountId)).toEqual(ACTIVE);
    expect(await sanctionRow(ctx, suspension.id)).toMatchObject({
      lifted_at: NIGHT_22_10,
      lifted_by: null,
    });
    expect(await bankLogin(app)).toMatchObject({ outcome: "resumed", accountId: a.accountId });
  });

  test("A shadow-banned person gets the same answers from every route", async ({ ctx }) => {
    await withMatchingConfig(ctx.client, { exports_per_day: 5 });
    const { app } = await appFor(ctx);
    const a = await signedInAccount(ctx.client);
    const changedAt = new Date("2026-10-01T08:00:00Z");
    await ctx.client.query("UPDATE account SET state_changed_at = $2 WHERE id = $1", [
      a.accountId,
      changedAt,
    ]);
    const moderator = await staffSession(ctx.client);

    const shadow = await created(await apply(app, moderator, a.accountId, SHADOW_BAN));
    expect(await stateOf(ctx, a.accountId)).toMatchObject({
      state: "shadow_banned",
      standing: "ok",
    });

    const onboarding = await app.request("/onboarding", { headers: a.headers });
    expect(onboarding.status).toBe(200);
    expect(OnboardingStatus.parse(await onboarding.json()).state).toBe("active");
    const document = await exportOf(app, a.headers);
    expect(document.account).toMatchObject({
      state: "active",
      stateChangedAt: changedAt.toISOString(),
    });
    expect(document.sanctions).toEqual([]);

    // Lifted, it is the person's to read, and still no date moved.
    expect((await liftOf(app, moderator, shadow.id)).status).toBe(200);
    const after = await exportOf(app, a.headers);
    expect(after.account.stateChangedAt).toBe(changedAt.toISOString());
    expect(after.sanctions).toEqual([
      {
        kind: "shadow_ban",
        kindInWords: expect.any(String),
        reason: "scraping",
        reasonInWords: expect.any(String),
        appliedAt: T.toISOString(),
        endsAt: null,
        liftedAt: T.toISOString(),
        lookedAtAgain: false,
      },
    ]);
    expect(JSON.stringify(after)).not.toContain(TOKEN);
    expect(JSON.stringify(after)).not.toContain(moderator.identityId);
  });

  test("A photo of a sanctioned owner is not served from a shown card", async ({ ctx }) => {
    await withMatchingConfig(ctx.client, {
      photo_fetches_per_day: { thumb: 20, card: 20, full: 20 },
    });
    const { app } = await appFor(ctx, { media: true });
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const photoId = await approvedPhoto(ctx, a.accountId);
    await recordCardServed(ctx.client, {
      viewerAccountId: b.accountId,
      subjectAccountId: a.accountId,
      photoIds: [photoId],
      at: T,
      since: new Date("2026-10-19T21:00:00Z"),
      limit: 100,
    });
    const card = (headers: Headers) => app.request(`/photos/${photoId}/card`, { headers });
    expect((await card(b.headers)).status).toBe(200);
    const moderator = await staffSession(ctx.client);

    const shadow = await created(await apply(app, moderator, a.accountId, SHADOW_BAN));
    const refused = await card(b.headers);
    expect(refused.status).toBe(404);
    expect(await errorCode(refused)).toBe("not_found");
    expect((await card(a.headers)).status).toBe(200);

    expect((await liftOf(app, moderator, shadow.id)).status).toBe(200);
    expect((await card(b.headers)).status).toBe(200);
    // Nothing was deleted on the way: the viewer's record of the card is as it was.
    expect(
      await count(ctx, "SELECT count(*) AS n FROM card_shown WHERE account_id = $1", [b.accountId]),
    ).toBe(1);
  });

  test("Lifting one of two sanctions settles to what is still open", async ({ ctx }) => {
    const { app } = await appFor(ctx);
    const a = await signedInAccount(ctx.client);
    const moderator = await staffSession(ctx.client);
    const shadow = await created(await apply(app, moderator, a.accountId, SHADOW_BAN));
    await created(await apply(app, moderator, a.accountId, SUSPEND));
    const suspended = {
      state: "suspended",
      paused_from: null,
      sanctioned_from: "active",
      standing: "suspended",
      suspension_ends_at: new Date(START_OF_22_10),
    };
    expect(await stateOf(ctx, a.accountId)).toEqual(suspended);

    expect((await liftOf(app, moderator, shadow.id)).status).toBe(200);
    expect(await stateOf(ctx, a.accountId)).toEqual(suspended);

    expect(await endSuspensions(ctx.client, NIGHT_22_10)).toBe(1);
    expect(await stateOf(ctx, a.accountId)).toEqual(ACTIVE);
  });

  test("A sanction on a person on a break keeps the break", async ({ ctx }) => {
    const { app } = await appFor(ctx);
    const a = await bankPerson(ctx, app);
    expect((await send(app, a.headers, "/account/pause", { confirm: true })).status).toBe(204);
    expect(await stateOf(ctx, a.accountId)).toMatchObject({
      state: "paused",
      paused_from: "active",
    });
    const moderator = await staffSession(ctx.client);

    const shadow = await created(await apply(app, moderator, a.accountId, SHADOW_BAN));
    expect(await stateOf(ctx, a.accountId)).toEqual({
      state: "paused",
      paused_from: "shadow_banned",
      sanctioned_from: null,
      standing: "ok",
      suspension_ends_at: null,
    });
    expect((await liftOf(app, moderator, shadow.id)).status).toBe(200);
    expect(await stateOf(ctx, a.accountId)).toEqual({
      state: "paused",
      paused_from: "active",
      sanctioned_from: null,
      standing: "ok",
      suspension_ends_at: null,
    });

    expect(await bankLogin(app)).toMatchObject({ outcome: "unpaused", accountId: a.accountId });
    expect(await stateOf(ctx, a.accountId)).toEqual(ACTIVE);
  });

  test("A shadow ban set before the profile is finished holds from the activation", async ({
    ctx,
  }) => {
    const { app } = await appFor(ctx);
    const pondId = await pondNamed(ctx.client, "test-sanctions-307");
    const [accountId] = await people(ctx.client, pondId, 1, {
      complete: true,
      consented: true,
      gender: "woman",
    });
    if (!accountId) throw new Error("no person written");
    await ctx.client.query("UPDATE account SET state = 'registered' WHERE id = $1", [accountId]);
    const a = await signInAs(ctx.client, accountId);
    const moderator = await staffSession(ctx.client);

    await created(await apply(app, moderator, accountId, SHADOW_BAN));
    expect(await stateOf(ctx, accountId)).toMatchObject({ state: "registered", standing: "ok" });

    const status = async () => {
      const response = await app.request("/onboarding", { headers: a.headers });
      expect(response.status).toBe(200);
      return OnboardingStatus.parse(await response.json()).state;
    };
    expect(await status()).toBe("active");
    expect(await stateOf(ctx, accountId)).toMatchObject({ state: "shadow_banned" });
    // Read again: the activation does not run twice, and the answer is the same.
    expect(await status()).toBe("active");
    expect(await stateOf(ctx, accountId)).toMatchObject({ state: "shadow_banned" });
  });

  test("A review is by somebody other than who applied the sanction", async ({ ctx }) => {
    const { app } = await appFor(ctx);
    const a = await bankPerson(ctx, app);
    const m = await staffSession(ctx.client, "moderator");
    const n = await staffSession(ctx.client, "moderator");
    const suspension = await created(await apply(app, m, a.accountId, SUSPEND));

    const own = await reviewOf(app, m, suspension.id, { note: "It stands.", outcome: "keep" });
    expect(own.status).toBe(409);
    expect(await errorCode(own)).toBe("own_sanction");
    expect(await sanctionRow(ctx, suspension.id)).toMatchObject({ reviewed_at: null });

    const words = "A misunderstanding between two friends; lifted.";
    const reviewed = await reviewOf(app, n, suspension.id, { note: words, outcome: "lift" });
    expect(reviewed.status).toBe(200);
    expect(Sanction.parse(await reviewed.json())).toMatchObject({
      id: suspension.id,
      createdBy: m.identityId,
      reviewNote: words,
      reviewedBy: n.identityId,
      reviewedAt: T.toISOString(),
      liftedBy: n.identityId,
      liftedAt: T.toISOString(),
    });
    expect(await stateOf(ctx, a.accountId)).toEqual(ACTIVE);
    expect(await bankLogin(app)).toMatchObject({ outcome: "resumed", accountId: a.accountId });
  });

  test("A ban is an admin's, and so are its lift and review", async ({ ctx }) => {
    const { app } = await appFor(ctx);
    const a = await signedInAccount(ctx.client);
    const m = await staffSession(ctx.client, "moderator");
    const d = await staffSession(ctx.client, "admin");
    const e = await staffSession(ctx.client, "admin");
    const forbidden = async (response: Response) => {
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe("admin_forbidden");
    };

    await forbidden(await banOf(app, m, a.accountId));
    // A ban is no kind of the moderators' route either.
    const asKind = await apply(app, m, a.accountId, { ...BAN, kind: "ban" });
    expect(asKind.status).toBe(400);
    expect(await errorCode(asKind)).toBe("validation_failed");
    expect(await sanctionsOf(ctx, a.accountId)).toBe(0);
    expect(await auditCount(ctx, a.accountId)).toBe(0);
    expect(await stateOf(ctx, a.accountId)).toEqual(ACTIVE);

    const ban = await created(await banOf(app, d, a.accountId));
    expect(ban).toMatchObject({ kind: "ban", createdBy: d.identityId });

    await forbidden(await liftOf(app, m, ban.id, "bans"));
    await forbidden(
      await reviewOf(app, m, ban.id, { note: "Too harsh.", outcome: "lift" }, "bans"),
    );
    // Nor do the moderators' own routes reach it.
    const viaLift = await liftOf(app, m, ban.id);
    expect(viaLift.status).toBe(404);
    expect(await errorCode(viaLift)).toBe("not_found");
    const viaReview = await reviewOf(app, m, ban.id, { note: "Too harsh.", outcome: "lift" });
    expect(viaReview.status).toBe(404);
    expect(await sanctionRow(ctx, ban.id)).toMatchObject({ lifted_at: null, reviewed_at: null });
    expect(await auditBy(ctx, [m.identityId])).toBe(0);
    expect(await stateOf(ctx, a.accountId)).toMatchObject({ state: "banned", standing: "banned" });

    // Another admin looks at it again, and the one who set it lifts it.
    const kept = await reviewOf(app, e, ban.id, { note: "It stands.", outcome: "keep" }, "bans");
    expect(kept.status).toBe(200);
    expect(Sanction.parse(await kept.json())).toMatchObject({
      reviewedBy: e.identityId,
      liftedAt: null,
    });
    const lifted = await liftOf(app, d, ban.id, "bans");
    expect(lifted.status).toBe(200);
    expect(Sanction.parse(await lifted.json())).toMatchObject({ liftedBy: d.identityId });
    expect(await stateOf(ctx, a.accountId)).toEqual(ACTIVE);
  });

  test("A ban binds an erased account's identity", async ({ ctx }) => {
    const { app } = await appFor(ctx);
    const a = await signedInAccount(ctx.client);
    expect((await send(app, a.headers, "/account/delete", { confirm: true })).status).toBe(204);
    const admin = await staffSession(ctx.client, "admin");

    const ban = await created(await banOf(app, admin, a.accountId));
    expect(ban).toMatchObject({ kind: "ban", accountId: a.accountId });
    expect(await stateOf(ctx, a.accountId)).toEqual({
      state: "deleted",
      paused_from: null,
      sanctioned_from: null,
      standing: "banned",
      suspension_ends_at: null,
    });

    const moderator = await staffSession(ctx.client);
    for (const body of [WARN, SUSPEND, SHADOW_BAN]) {
      const refused = await apply(app, moderator, a.accountId, body);
      expect(refused.status).toBe(409);
      expect(await errorCode(refused)).toBe("account_deleted");
    }
    expect(await sanctionsOf(ctx, a.accountId)).toBe(1);
    expect(await auditBy(ctx, [moderator.identityId])).toBe(0);
  });

  test("Every sanction step writes the audit log before it happens", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const seen: number[] = [];
    const db = probed(ctx.client, /INSERT INTO sanction|UPDATE sanction SET/, async () => {
      seen.push(await auditCount(ctx, a.accountId));
    });
    const { app } = await appFor(ctx, { db });
    const m = await staffSession(ctx.client);
    const n = await staffSession(ctx.client);

    const warning = await created(await apply(app, m, a.accountId, WARN));
    const suspension = await created(await apply(app, m, a.accountId, SUSPEND));
    expect((await liftOf(app, m, warning.id)).status).toBe(200);
    expect(
      (await reviewOf(app, n, suspension.id, { note: "It stands.", outcome: "keep" })).status,
    ).toBe(200);
    // Each step's own audit row was there before its sanction row was written.
    expect(seen).toEqual([1, 2, 3, 4]);

    const rows = await auditOf(ctx, a.accountId);
    expect(rows).toHaveLength(4);
    const step = (actor: Staff, action: string, detail: Record<string, unknown>) => ({
      actor_identity_id: actor.identityId,
      action,
      subject_type: "account",
      detail,
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        step(m, "sanction.apply", { sanctionId: warning.id, kind: "warn", reason: "harassment" }),
        step(m, "sanction.apply", {
          sanctionId: suspension.id,
          kind: "suspend",
          reason: "harassment",
        }),
        step(m, "sanction.lift", { sanctionId: warning.id, kind: "warn", reason: "harassment" }),
        step(n, "sanction.review", {
          sanctionId: suspension.id,
          kind: "suspend",
          reason: "harassment",
          outcome: "keep",
        }),
      ]),
    );

    const refusals: [Response, number, string][] = [
      [await liftOf(app, n, warning.id), 409, "sanction_lifted"],
      [await reviewOf(app, m, warning.id, { note: "Mine.", outcome: "keep" }), 409, "own_sanction"],
      [
        await reviewOf(app, n, suspension.id, { note: "Again.", outcome: "lift" }),
        409,
        "sanction_reviewed",
      ],
      [
        await apply(app, m, a.accountId, { ...SUSPEND, endsOn: "2026-10-20" }),
        400,
        "ends_on_invalid",
      ],
      [await apply(app, m, UNKNOWN_ID, WARN), 404, "not_found"],
      [await liftOf(app, m, UNKNOWN_ID), 404, "not_found"],
    ];
    for (const [response, status, code] of refusals) {
      expect(response.status).toBe(status);
      expect(await errorCode(response)).toBe(code);
    }
    expect(await auditBy(ctx, [m.identityId, n.identityId])).toBe(4);
    expect(await sanctionRow(ctx, warning.id)).toMatchObject({ lifted_by: m.identityId });
  });

  test("The note reaches no log line and no error", async ({ ctx }) => {
    const { app, logs } = await appFor(ctx);
    const a = await signedInAccount(ctx.client);
    const gone = await tombstone(ctx);
    const m = await staffSession(ctx.client);
    const n = await staffSession(ctx.client);

    const suspension = await created(await apply(app, m, a.accountId, SUSPEND));
    expect(suspension.note).toBe(NOTE);
    expect(logs().find((line) => line.msg === "sanction applied")).toMatchObject({
      staffIdentityId: m.identityId,
      accountId: a.accountId,
      sanctionId: suspension.id,
      kind: "suspend",
      reason: "harassment",
    });
    const reviewWords = `Kept after a call, ticket ${TOKEN}`;
    expect(
      (await reviewOf(app, n, suspension.id, { note: reviewWords, outcome: "keep" })).status,
    ).toBe(200);

    const refused = [
      await apply(app, m, a.accountId, { ...SUSPEND, endsOn: "2026-10-20" }),
      await apply(app, m, a.accountId, { ...WARN, note: `${NOTE} ${"x".repeat(500)}` }),
      await apply(app, m, gone, WARN),
      await reviewOf(app, n, suspension.id, { note: reviewWords, outcome: "lift" }),
    ];
    expect(refused.map((response) => response.status)).toEqual([400, 400, 409, 409]);
    for (const response of refused) expect(await response.text()).not.toContain(TOKEN);

    const everything = JSON.stringify(logs());
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("forty people");
  });
});

describe("applySanction", () => {
  test.for([
    ["today in Finland", T, "2026-10-20"],
    ["yesterday", T, "2026-10-19"],
    [
      "today in Finland while it is yesterday in UTC",
      new Date("2026-10-20T22:30:00Z"),
      "2026-10-21",
    ],
    ["the 367th day ahead", T, "2027-10-22"],
  ] as const)("a suspension refuses %s as its end", async ([, at, endsOn], { ctx }) => {
    const a = await signedInAccount(ctx.client);
    await expect(
      applySanction(ctx.client, input(a.accountId, "suspend", { at, endsOn })),
    ).rejects.toMatchObject({ status: 400, code: "ends_on_invalid" });
    expect(await sanctionsOf(ctx, a.accountId)).toBe(0);
    expect(await stateOf(ctx, a.accountId)).toEqual(ACTIVE);
  });

  test("a suspension refuses the 367th day ahead across the change to summer time", async ({
    ctx,
  }) => {
    // 23:30 on 28.3.2026 in Finland (winter time); 366 days on is 29.3.2027, in summer time.
    const at = new Date("2026-03-28T21:30:00Z");
    const a = await signedInAccount(ctx.client);
    await expect(
      applySanction(ctx.client, input(a.accountId, "suspend", { at, endsOn: "2027-03-30" })),
    ).rejects.toMatchObject({ status: 400, code: "ends_on_invalid" });
    const last = await applySanction(
      ctx.client,
      input(a.accountId, "suspend", { at, endsOn: "2027-03-29" }),
    );
    expect(last.endsAt).toBe("2027-03-28T21:00:00.000Z");
  });

  test("a suspension without its end is refused", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const withoutEnd = { ...input(a.accountId, "warn"), kind: "suspend" as const };
    await expect(applySanction(ctx.client, withoutEnd)).rejects.toMatchObject({
      status: 400,
      code: "ends_on_invalid",
    });
    expect(await sanctionsOf(ctx, a.accountId)).toBe(0);
  });

  test.for([
    ["tomorrow", T, "2026-10-21", "2026-10-20T21:00:00.000Z"],
    ["the 366th day ahead", T, "2027-10-21", "2027-10-20T21:00:00.000Z"],
    [
      "tomorrow in Finland while it is today in UTC",
      new Date("2026-10-20T22:30:00Z"),
      "2026-10-22",
      "2026-10-21T21:00:00.000Z",
    ],
    ["the last day that starts in summer time", T, "2026-10-25", "2026-10-24T21:00:00.000Z"],
    ["the first day that starts in winter time", T, "2026-10-26", "2026-10-25T22:00:00.000Z"],
    ["a day in winter", T, "2027-01-15", "2027-01-14T22:00:00.000Z"],
    ["the day the clocks go forward", T, "2027-03-28", "2027-03-27T22:00:00.000Z"],
    ["a day in summer", T, "2027-07-01", "2027-06-30T21:00:00.000Z"],
  ] as const)(
    "a suspension until %s ends at the start of that day in Finland",
    async ([, at, endsOn, endsAt], { ctx }) => {
      const a = await signedInAccount(ctx.client);
      const suspension = await applySanction(
        ctx.client,
        input(a.accountId, "suspend", { at, endsOn }),
      );
      expect(suspension.endsAt).toBe(endsAt);
      expect(await stateOf(ctx, a.accountId)).toMatchObject({
        state: "suspended",
        standing: "suspended",
        suspension_ends_at: new Date(endsAt),
      });
    },
  );

  test("the identity waits for the latest of two suspensions", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const later = await applySanction(
      ctx.client,
      input(a.accountId, "suspend", { endsOn: "2026-11-02" }),
    );
    await applySanction(ctx.client, input(a.accountId, "suspend", { endsOn: "2026-10-22" }));
    expect(await stateOf(ctx, a.accountId)).toMatchObject({
      suspension_ends_at: new Date("2026-11-01T22:00:00Z"),
    });
    const admin = await staffSession(ctx.client, "admin");
    await liftSanction(ctx.client, {
      sanctionId: later.id,
      scope: "other",
      actor: admin.identityId,
      at: T,
    });
    expect(await stateOf(ctx, a.accountId)).toMatchObject({
      state: "suspended",
      suspension_ends_at: new Date(START_OF_22_10),
    });
  });

  test("an end given with anything but a suspension is not kept", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const warning = await applySanction(ctx.client, {
      ...input(a.accountId, "warn"),
      endsOn: "2026-10-22",
    });
    expect(warning.endsAt).toBeNull();
    expect(await stateOf(ctx, a.accountId)).toEqual(ACTIVE);
  });

  test.for(["warn", "shadow_ban", "suspend"] as const)(
    "a %s of a tombstone is refused with account_deleted",
    async (kind, { ctx }) => {
      const gone = await tombstone(ctx);
      const moderator = await staffSession(ctx.client);
      await expect(
        applySanction(ctx.client, input(gone, kind, { actor: moderator.identityId })),
      ).rejects.toMatchObject({ status: 409, code: "account_deleted" });
      expect(await sanctionsOf(ctx, gone)).toBe(0);
      expect(await auditCount(ctx, gone)).toBe(0);
      expect(await stateOf(ctx, gone)).toMatchObject({ state: "deleted", standing: "ok" });
    },
  );

  test("an unknown account is not found and nothing is written", async ({ ctx }) => {
    const moderator = await staffSession(ctx.client);
    await expect(
      applySanction(ctx.client, input(UNKNOWN_ID, "warn", { actor: moderator.identityId })),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(await auditBy(ctx, [moderator.identityId])).toBe(0);
    expect(await count(ctx, "SELECT count(*) AS n FROM sanction")).toBe(0);
  });

  test("a sanction that nobody applied writes no audit row", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const ban = await applySanction(ctx.client, input(a.accountId, "ban"));
    expect(ban).toMatchObject({ kind: "ban", createdBy: null });
    expect(await auditCount(ctx, a.accountId)).toBe(0);
    expect(await stateOf(ctx, a.accountId)).toMatchObject({ state: "banned", standing: "banned" });
  });

  test("a warning and a shadow ban leave every session and the visible date alone", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const changedAt = new Date("2026-10-01T08:00:00Z");
    await ctx.client.query("UPDATE account SET state_changed_at = $2 WHERE id = $1", [
      a.accountId,
      changedAt,
    ]);
    await applySanction(ctx.client, input(a.accountId, "warn"));
    await applySanction(ctx.client, input(a.accountId, "shadow_ban"));
    expect(
      await count(
        ctx,
        "SELECT count(*) AS n FROM session WHERE account_id = $1 AND revoked_at IS NULL",
        [a.accountId],
      ),
    ).toBe(1);
    const { rows } = await ctx.client.query(
      "SELECT state, state_changed_at FROM account WHERE id = $1",
      [a.accountId],
    );
    expect(rows[0]).toEqual({ state: "shadow_banned", state_changed_at: changedAt });
  });

  test("a suspension ends the identity's panel sessions too", async ({ ctx }) => {
    // A former moderator: the role is gone, a panel session row is still open.
    const staff = await staffSession(ctx.client, "moderator");
    await ctx.client.query("DELETE FROM moderator_roles WHERE identity_id = $1", [
      staff.identityId,
    ]);
    const { rows } = await ctx.client.query<{ id: string }>(
      "INSERT INTO account (identity_id, state, birth_year, birth_month) VALUES ($1, 'active', 1990, 6) RETURNING id",
      [staff.identityId],
    );
    const accountId = rows[0]?.id ?? "";
    const panelOpen = () =>
      count(
        ctx,
        "SELECT count(*) AS n FROM admin_session WHERE identity_id = $1 AND revoked_at IS NULL",
        [staff.identityId],
      );
    await applySanction(ctx.client, input(accountId, "warn"));
    expect(await panelOpen()).toBe(1);
    await applySanction(ctx.client, input(accountId, "suspend"));
    expect(await panelOpen()).toBe(0);
  });

  test("refuses a member of staff as the target, whatever the kind, and writes nothing", async ({
    ctx,
  }) => {
    const admin = await staffSession(ctx.client, "admin");
    for (const role of ["moderator", "admin", "researcher"] as const) {
      const target = await staffSession(ctx.client, role);
      const { rows } = await ctx.client.query<{ id: string }>(
        "INSERT INTO account (identity_id, state, birth_year, birth_month) VALUES ($1, 'active', 1990, 6) RETURNING id",
        [target.identityId],
      );
      const accountId = rows[0]?.id ?? "";
      for (const kind of ["warn", "shadow_ban", "suspend", "ban"] as const) {
        await expect(
          applySanction(ctx.client, input(accountId, kind, { actor: admin.identityId })),
        ).rejects.toMatchObject({ status: 409, code: "staff_target" });
      }
      expect(
        await count(ctx, "SELECT count(*) AS n FROM sanction WHERE account_id = $1", [accountId]),
      ).toBe(0);
    }
    expect(
      await count(ctx, "SELECT count(*) AS n FROM audit_log WHERE actor_identity_id = $1", [
        admin.identityId,
      ]),
    ).toBe(0);
  });

  test("refuses a member of staff lifting or looking again at a sanction on themselves", async ({
    ctx,
  }) => {
    // Sanctioned as a person, given a role afterwards by the maintainer's tool.
    const person = await signedInAccount(ctx.client);
    const moderator = await staffSession(ctx.client, "moderator");
    const sanction = await applySanction(
      ctx.client,
      input(person.accountId, "shadow_ban", { actor: moderator.identityId }),
    );
    const identityId = await identityOf(ctx, person.accountId);
    await ctx.client.query(
      "INSERT INTO moderator_roles (identity_id, role, granted_by) VALUES ($1, 'moderator', 'test')",
      [identityId],
    );
    await expect(
      liftSanction(ctx.client, {
        sanctionId: sanction.id,
        scope: "other",
        actor: identityId,
        at: T,
      }),
    ).rejects.toMatchObject({ status: 409, code: "own_account" });
    await expect(
      reviewSanction(ctx.client, {
        sanctionId: sanction.id,
        scope: "other",
        actor: identityId,
        note: "Not me.",
        outcome: "lift",
        at: T,
      }),
    ).rejects.toMatchObject({ status: 409, code: "own_account" });
    expect(await stateOf(ctx, person.accountId)).toMatchObject({ state: "shadow_banned" });
  });

  test("parses the note again: one the database would refuse never reaches it", async ({ ctx }) => {
    const person = await signedInAccount(ctx.client);
    for (const note of ["", "   ", "x".repeat(501)]) {
      await expect(
        applySanction(ctx.client, { ...input(person.accountId, "warn"), note }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed" });
    }
    const saved = await applySanction(ctx.client, {
      ...input(person.accountId, "warn"),
      note: "  Trimmed.  ",
    });
    expect(saved.note).toBe("Trimmed.");
  });

  test("a ban set through an erased account binds the identity's live account too", async ({
    ctx,
  }) => {
    // The person came back after the cooldown; staff ban them from the old account's page.
    const live = await signedInAccount(ctx.client);
    const old = await tombstone(ctx, await identityOf(ctx, live.accountId));
    const admin = await staffSession(ctx.client, "admin");
    await applySanction(ctx.client, input(old, "ban", { actor: admin.identityId }));
    expect(await stateOf(ctx, old)).toMatchObject({ state: "deleted", standing: "banned" });
    // ADR-024 §2: the state is banned with the standing; §4: the sessions end, so a lift brings no device back.
    expect(await stateOf(ctx, live.accountId)).toMatchObject({
      state: "banned",
      standing: "banned",
    });
    expect(
      await count(
        ctx,
        "SELECT count(*) AS n FROM session WHERE account_id = $1 AND revoked_reason = 'sanction'",
        [live.accountId],
      ),
    ).toBe(1);
  });

  test.for(["lift", "review"] as const)(
    "a %s of a ban set through an erased account gives the live account back and forgets the kept row",
    async (how, { ctx }) => {
      const live = await signedInAccount(ctx.client);
      const old = await tombstone(ctx, await identityOf(ctx, live.accountId));
      const admin = await staffSession(ctx.client, "admin");
      const other = await staffSession(ctx.client, "admin");
      const ban = await applySanction(ctx.client, input(old, "ban", { actor: admin.identityId }));
      if (how === "lift") {
        await liftSanction(ctx.client, {
          sanctionId: ban.id,
          scope: "ban",
          actor: admin.identityId,
          at: T,
        });
      } else {
        await reviewSanction(ctx.client, {
          sanctionId: ban.id,
          scope: "ban",
          actor: other.identityId,
          note: "Wrong person.",
          outcome: "lift",
          at: T,
        });
      }
      // ADR-024 §2: every account of the identity is settled, the live one back to what it was.
      expect(await stateOf(ctx, live.accountId)).toEqual(ACTIVE);
      expect(await stateOf(ctx, old)).toMatchObject({ state: "deleted", standing: "ok" });
      // §8: a row kept on the erased account only for its standing goes once lifted.
      expect(await count(ctx, "SELECT count(*) AS n FROM sanction WHERE id = $1", [ban.id])).toBe(
        0,
      );
    },
  );

  test("parses a review's note again: one the database would refuse never reaches it", async ({
    ctx,
  }) => {
    const person = await signedInAccount(ctx.client);
    const m = await staffSession(ctx.client, "moderator");
    const n = await staffSession(ctx.client, "moderator");
    const warning = await applySanction(
      ctx.client,
      input(person.accountId, "warn", { actor: m.identityId }),
    );
    for (const note of ["", "   ", "x".repeat(501)]) {
      await expect(
        reviewSanction(ctx.client, {
          sanctionId: warning.id,
          scope: "other",
          actor: n.identityId,
          note,
          outcome: "keep",
          at: T,
        }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed" });
    }
    expect((await sanctionRow(ctx, warning.id))?.reviewed_at).toBeNull();
    expect(
      await count(ctx, "SELECT count(*) AS n FROM audit_log WHERE actor_identity_id = $1", [
        n.identityId,
      ]),
    ).toBe(0);
    const kept = await reviewSanction(ctx.client, {
      sanctionId: warning.id,
      scope: "other",
      actor: n.identityId,
      note: "  Kept.  ",
      outcome: "keep",
      at: T,
    });
    expect(kept.reviewNote).toBe("Kept.");
  });
});

describe("liftSanction and reviewSanction", () => {
  test("a second lift is refused with sanction_lifted and its audit row goes with it", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const m = await staffSession(ctx.client);
    const n = await staffSession(ctx.client);
    const shadow = await applySanction(
      ctx.client,
      input(a.accountId, "shadow_ban", { actor: m.identityId }),
    );
    const first = new Date("2026-10-21T09:00:00Z");
    await liftSanction(ctx.client, {
      sanctionId: shadow.id,
      scope: "other",
      actor: m.identityId,
      at: first,
    });
    await expect(
      liftSanction(ctx.client, {
        sanctionId: shadow.id,
        scope: "other",
        actor: n.identityId,
        at: T,
      }),
    ).rejects.toMatchObject({ status: 409, code: "sanction_lifted" });
    expect(await sanctionRow(ctx, shadow.id)).toMatchObject({
      lifted_at: first,
      lifted_by: m.identityId,
    });
    expect(await auditBy(ctx, [n.identityId])).toBe(0);
    expect(await stateOf(ctx, a.accountId)).toEqual(ACTIVE);
  });

  test("two lifts at once leave one lift and one audit row", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const m = await staffSession(ctx.client);
    const n = await staffSession(ctx.client);
    const shadow = await applySanction(
      ctx.client,
      input(a.accountId, "shadow_ban", { actor: m.identityId }),
    );
    const theirs = new Date("2026-10-20T10:00:00Z");
    // N's lift commits after M's has read the sanction as open.
    const db = interleaved(ctx.client, SANCTION_READ, () =>
      liftSanction(ctx.client, {
        sanctionId: shadow.id,
        scope: "other",
        actor: n.identityId,
        at: theirs,
      }),
    );
    await expect(
      liftSanction(db, { sanctionId: shadow.id, scope: "other", actor: m.identityId, at: T }),
    ).rejects.toMatchObject({ status: 409, code: "sanction_lifted" });
    expect(db.ran()).toBe(true);
    expect(await sanctionRow(ctx, shadow.id)).toMatchObject({
      lifted_at: theirs,
      lifted_by: n.identityId,
    });
    const lifts = (await auditOf(ctx, a.accountId)).filter((row) => row.action === "sanction.lift");
    expect(lifts.map((row) => row.actor_identity_id)).toEqual([n.identityId]);
    expect(await stateOf(ctx, a.accountId)).toEqual(ACTIVE);
  });

  test("a sanction is reached only through the route of its kind", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const admin = await staffSession(ctx.client, "admin");
    const ban = await applySanction(ctx.client, input(a.accountId, "ban"));
    const warning = await applySanction(ctx.client, input(a.accountId, "warn"));
    const notFound = { status: 404, code: "not_found" };
    const lift = (sanctionId: string, scope: "ban" | "other") =>
      liftSanction(ctx.client, { sanctionId, scope, actor: admin.identityId, at: T });
    const review = (sanctionId: string, scope: "ban" | "other") =>
      reviewSanction(ctx.client, {
        sanctionId,
        scope,
        actor: admin.identityId,
        note: "Looked at.",
        outcome: "lift",
        at: T,
      });
    await expect(lift(ban.id, "other")).rejects.toMatchObject(notFound);
    await expect(lift(warning.id, "ban")).rejects.toMatchObject(notFound);
    await expect(lift(UNKNOWN_ID, "ban")).rejects.toMatchObject(notFound);
    await expect(review(ban.id, "other")).rejects.toMatchObject(notFound);
    await expect(review(warning.id, "ban")).rejects.toMatchObject(notFound);
    await expect(review(UNKNOWN_ID, "other")).rejects.toMatchObject(notFound);
    expect(await auditBy(ctx, [admin.identityId])).toBe(0);
    expect(await stateOf(ctx, a.accountId)).toMatchObject({ state: "banned" });
  });

  test("a second review is refused with sanction_reviewed", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const m = await staffSession(ctx.client);
    const n = await staffSession(ctx.client);
    const d = await staffSession(ctx.client, "admin");
    const warning = await applySanction(
      ctx.client,
      input(a.accountId, "warn", { actor: m.identityId }),
    );
    const review = (actor: Staff, outcome: "keep" | "lift", note: string) =>
      reviewSanction(ctx.client, {
        sanctionId: warning.id,
        scope: "other",
        actor: actor.identityId,
        note,
        outcome,
        at: T,
      });
    await review(n, "keep", "It stands.");
    for (const outcome of ["keep", "lift"] as const) {
      await expect(review(d, outcome, "Again.")).rejects.toMatchObject({
        status: 409,
        code: "sanction_reviewed",
      });
    }
    expect(await sanctionRow(ctx, warning.id)).toMatchObject({
      reviewed_by: n.identityId,
      review_note: "It stands.",
      lifted_at: null,
    });
    expect(await auditBy(ctx, [d.identityId])).toBe(0);
  });

  test("a review that lifts a lifted sanction is refused, one that keeps it is not", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const m = await staffSession(ctx.client);
    const n = await staffSession(ctx.client);
    const suspension = await applySanction(
      ctx.client,
      input(a.accountId, "suspend", { actor: m.identityId }),
    );
    await liftSanction(ctx.client, {
      sanctionId: suspension.id,
      scope: "other",
      actor: m.identityId,
      at: T,
    });
    const review = (outcome: "keep" | "lift") =>
      reviewSanction(ctx.client, {
        sanctionId: suspension.id,
        scope: "other",
        actor: n.identityId,
        note: "Looked at.",
        outcome,
        at: new Date("2026-10-21T09:00:00Z"),
      });
    await expect(review("lift")).rejects.toMatchObject({ status: 409, code: "sanction_lifted" });
    expect(await auditBy(ctx, [n.identityId])).toBe(0);
    const kept = await review("keep");
    expect(kept).toMatchObject({
      reviewedBy: n.identityId,
      liftedBy: m.identityId,
      liftedAt: T.toISOString(),
    });
    expect(await stateOf(ctx, a.accountId)).toEqual(ACTIVE);
  });

  test("a review that keeps a suspension leaves the account as it is", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const m = await staffSession(ctx.client);
    const n = await staffSession(ctx.client);
    const suspension = await applySanction(
      ctx.client,
      input(a.accountId, "suspend", { actor: m.identityId }),
    );
    const before = await stateOf(ctx, a.accountId);
    const kept = await reviewSanction(ctx.client, {
      sanctionId: suspension.id,
      scope: "other",
      actor: n.identityId,
      note: "It stands.",
      outcome: "keep",
      at: T,
    });
    expect(kept).toMatchObject({ reviewedBy: n.identityId, liftedAt: null, liftedBy: null });
    expect(await stateOf(ctx, a.accountId)).toEqual(before);
    expect(before).toMatchObject({ state: "suspended", standing: "suspended" });
  });

  test("a sanction nobody applied may be looked at again by anybody", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const admin = await staffSession(ctx.client, "admin");
    const ban = await applySanction(ctx.client, input(a.accountId, "ban"));
    const reviewed = await reviewSanction(ctx.client, {
      sanctionId: ban.id,
      scope: "ban",
      actor: admin.identityId,
      note: "The demo's ban, lifted.",
      outcome: "lift",
      at: T,
    });
    expect(reviewed).toMatchObject({ createdBy: null, liftedBy: admin.identityId });
    expect(await stateOf(ctx, a.accountId)).toEqual(ACTIVE);
  });

  test("two reviews at once leave one review", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const m = await staffSession(ctx.client);
    const n = await staffSession(ctx.client);
    const d = await staffSession(ctx.client, "admin");
    const suspension = await applySanction(
      ctx.client,
      input(a.accountId, "suspend", { actor: m.identityId }),
    );
    const review = (db: Queryable, actor: Staff, outcome: "keep" | "lift") =>
      reviewSanction(db, {
        sanctionId: suspension.id,
        scope: "other",
        actor: actor.identityId,
        note: `${outcome} by ${actor.role}`,
        outcome,
        at: T,
      });
    const db = interleaved(ctx.client, SANCTION_READ, () => review(ctx.client, n, "keep"));
    await expect(review(db, d, "lift")).rejects.toMatchObject({
      status: 409,
      code: "sanction_reviewed",
    });
    expect(db.ran()).toBe(true);
    expect(await sanctionRow(ctx, suspension.id)).toMatchObject({
      reviewed_by: n.identityId,
      lifted_at: null,
    });
    expect(await auditBy(ctx, [d.identityId])).toBe(0);
    expect(await stateOf(ctx, a.accountId)).toMatchObject({ state: "suspended" });
  });

  test("a review that lifts, racing a lift, is refused with sanction_lifted", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const m = await staffSession(ctx.client);
    const n = await staffSession(ctx.client);
    const suspension = await applySanction(
      ctx.client,
      input(a.accountId, "suspend", { actor: m.identityId }),
    );
    const db = interleaved(ctx.client, SANCTION_READ, () =>
      liftSanction(ctx.client, {
        sanctionId: suspension.id,
        scope: "other",
        actor: m.identityId,
        at: T,
      }),
    );
    await expect(
      reviewSanction(db, {
        sanctionId: suspension.id,
        scope: "other",
        actor: n.identityId,
        note: "Too long.",
        outcome: "lift",
        at: T,
      }),
    ).rejects.toMatchObject({ status: 409, code: "sanction_lifted" });
    expect(db.ran()).toBe(true);
    expect(await sanctionRow(ctx, suspension.id)).toMatchObject({
      lifted_by: m.identityId,
      reviewed_at: null,
    });
    expect(await auditBy(ctx, [n.identityId])).toBe(0);
  });
});

describe("endSuspensions", () => {
  test("the night ends only the suspension that is due when an account has two", async ({
    ctx,
  }) => {
    const m = await staffSession(ctx.client);
    const person = await signedInAccount(ctx.client);
    const first = await applySanction(
      ctx.client,
      input(person.accountId, "suspend", { actor: m.identityId, endsOn: "2026-10-22" }),
    );
    const second = await applySanction(
      ctx.client,
      input(person.accountId, "suspend", { actor: m.identityId, endsOn: "2026-11-02" }),
    );
    expect(await endSuspensions(ctx.client, NIGHT_22_10)).toBe(1);
    expect((await sanctionRow(ctx, first.id))?.lifted_at).toEqual(NIGHT_22_10);
    expect((await sanctionRow(ctx, second.id))?.lifted_at).toBeNull();
    expect(await stateOf(ctx, person.accountId)).toMatchObject({
      state: "suspended",
      standing: "suspended",
      suspension_ends_at: new Date("2026-11-01T22:00:00Z"),
    });
    expect(await endSuspensions(ctx.client, new Date("2026-11-02T02:00:00Z"))).toBe(1);
    expect(await stateOf(ctx, person.accountId)).toEqual(ACTIVE);
  });

  test("the night ends what is past its day once, and leaves the rest", async ({ ctx }) => {
    const m = await staffSession(ctx.client);
    const due = await signedInAccount(ctx.client);
    const later = await signedInAccount(ctx.client);
    const lifted = await signedInAccount(ctx.client);
    const suspend = (accountId: string, endsOn: string) =>
      applySanction(ctx.client, input(accountId, "suspend", { actor: m.identityId, endsOn }));
    const dueOne = await suspend(due.accountId, "2026-10-22");
    const laterOne = await suspend(later.accountId, "2026-10-23");
    const liftedOne = await suspend(lifted.accountId, "2026-10-22");
    const liftedAt = new Date("2026-10-21T09:00:00Z");
    await liftSanction(ctx.client, {
      sanctionId: liftedOne.id,
      scope: "other",
      actor: m.identityId,
      at: liftedAt,
    });

    // The end is an instant: a millisecond before it nothing ends, at it the suspension does.
    expect(await endSuspensions(ctx.client, new Date(Date.parse(START_OF_22_10) - 1))).toBe(0);
    expect(await stateOf(ctx, due.accountId)).toMatchObject({ state: "suspended" });
    expect(await endSuspensions(ctx.client, new Date(START_OF_22_10))).toBe(1);
    // A second run of the same night finds nothing left.
    expect(await endSuspensions(ctx.client, NIGHT_22_10)).toBe(0);

    expect(await sanctionRow(ctx, dueOne.id)).toMatchObject({
      lifted_at: new Date(START_OF_22_10),
      lifted_by: null,
    });
    expect(await stateOf(ctx, due.accountId)).toEqual(ACTIVE);
    expect(await sanctionRow(ctx, laterOne.id)).toMatchObject({ lifted_at: null });
    expect(await stateOf(ctx, later.accountId)).toMatchObject({
      state: "suspended",
      standing: "suspended",
      suspension_ends_at: new Date("2026-10-22T21:00:00Z"),
    });
    expect(await sanctionRow(ctx, liftedOne.id)).toMatchObject({
      lifted_at: liftedAt,
      lifted_by: m.identityId,
    });
    expect(await stateOf(ctx, lifted.accountId)).toEqual(ACTIVE);
    // No person ended it: the audit log has the apply and nothing else.
    expect(await auditCount(ctx, due.accountId)).toBe(1);
  });

  test("a suspension of a person on a break ends on the break", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    await ctx.client.query(
      "UPDATE account SET state = 'paused', paused_from = 'active' WHERE id = $1",
      [a.accountId],
    );
    await applySanction(ctx.client, input(a.accountId, "suspend"));
    expect(await stateOf(ctx, a.accountId)).toMatchObject({
      state: "suspended",
      paused_from: "active",
      sanctioned_from: "paused",
    });
    expect(await endSuspensions(ctx.client, NIGHT_22_10)).toBe(1);
    expect(await stateOf(ctx, a.accountId)).toEqual({
      ...ACTIVE,
      state: "paused",
      paused_from: "active",
    });
  });

  test("a suspension kept on an erased account is ended by the night, and its row goes then", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const suspension = await applySanction(ctx.client, input(a.accountId, "suspend"));
    await applySanction(ctx.client, input(a.accountId, "warn"));
    const { logger } = await captureLogger();
    const erased = await eraseAccount({ db: ctx.client, logger, now: () => T }, a.accountId);
    expect(erased.sanctions).toBe(1);
    expect(await sanctionRow(ctx, suspension.id)).toMatchObject({ lifted_at: null });
    expect(await stateOf(ctx, a.accountId)).toEqual({
      state: "deleted",
      paused_from: null,
      sanctioned_from: null,
      standing: "suspended",
      suspension_ends_at: new Date(START_OF_22_10),
    });

    expect(await endSuspensions(ctx.client, NIGHT_22_10)).toBe(1);
    expect(await stateOf(ctx, a.accountId)).toEqual({
      state: "deleted",
      paused_from: null,
      sanctioned_from: null,
      standing: "ok",
      suspension_ends_at: null,
    });
    // ADR-024 §8: kept only while it carried the standing; once ended, it goes as the erasure would have.
    expect(await sanctionRow(ctx, suspension.id)).toBeUndefined();
  });
});

describe("the lists and the erasure's half", () => {
  test("listSanctions gives the account's own and the identity's bans from an older account, newest first", async ({
    ctx,
  }) => {
    const live = await signedInAccount(ctx.client);
    const old = await tombstone(ctx, await identityOf(ctx, live.accountId));
    const stranger = await signedInAccount(ctx.client);
    const at = (day: number) => new Date(`2026-10-${day}T09:00:00Z`);
    const warning = await applySanction(ctx.client, input(live.accountId, "warn", { at: at(11) }));
    const ban = await applySanction(ctx.client, input(old, "ban", { at: at(12) }));
    const shadow = await applySanction(
      ctx.client,
      input(live.accountId, "shadow_ban", { at: at(13) }),
    );
    await applySanction(ctx.client, input(stranger.accountId, "ban", { at: at(14) }));

    const listed = await listSanctions(ctx.client, live.accountId);
    expect(listed?.map((s) => s.id)).toEqual([shadow.id, ban.id, warning.id]);
    // Applied by nobody: no role beside it (#308).
    expect(listed?.[0]).toEqual({
      ...shadow,
      createdByRole: null,
      liftedByRole: null,
      reviewedByRole: null,
    });
    expect(listed?.[0]?.note).toBe(NOTE);
    expect((await listSanctions(ctx.client, old))?.map((s) => s.id)).toEqual([ban.id]);
    expect(await listSanctions(ctx.client, UNKNOWN_ID)).toBeNull();
  });

  test("listSanctionsOfAccount leaves out an open shadow ban and lists a lifted one", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const m = await staffSession(ctx.client);
    const n = await staffSession(ctx.client);
    const at = (day: number) => new Date(`2026-10-${day}T09:00:00Z`);
    await applySanction(ctx.client, input(a.accountId, "warn", { at: at(11) }));
    const lifted = await applySanction(
      ctx.client,
      input(a.accountId, "shadow_ban", { at: at(12) }),
    );
    await liftSanction(ctx.client, {
      sanctionId: lifted.id,
      scope: "other",
      actor: m.identityId,
      at: at(13),
    });
    await applySanction(ctx.client, input(a.accountId, "shadow_ban", { at: at(14) }));
    const suspension = await applySanction(
      ctx.client,
      input(a.accountId, "suspend", { at: at(15), endsOn: "2026-10-22", actor: m.identityId }),
    );
    await reviewSanction(ctx.client, {
      sanctionId: suspension.id,
      scope: "other",
      actor: n.identityId,
      note: "It stands.",
      outcome: "keep",
      at: at(16),
    });

    const own = await listSanctionsOfAccount(ctx.client, a.accountId, 10);
    expect(own).toEqual([
      {
        kind: "suspend",
        reason: "other",
        appliedAt: at(15).toISOString(),
        endsAt: START_OF_22_10,
        liftedAt: null,
        lookedAtAgain: true,
      },
      {
        kind: "shadow_ban",
        reason: "other",
        appliedAt: at(12).toISOString(),
        endsAt: null,
        liftedAt: at(13).toISOString(),
        lookedAtAgain: false,
      },
      {
        kind: "warn",
        reason: "other",
        appliedAt: at(11).toISOString(),
        endsAt: null,
        liftedAt: null,
        lookedAtAgain: false,
      },
    ]);
    expect(await listSanctionsOfAccount(ctx.client, a.accountId, 1)).toEqual(own.slice(0, 1));
  });

  test("deleteSanctionsOfAccount keeps the open bans and suspensions only", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const admin = await staffSession(ctx.client, "admin");
    const lifted = async (kind: SanctionKind) => {
      const sanction = await applySanction(ctx.client, input(a.accountId, kind));
      await liftSanction(ctx.client, {
        sanctionId: sanction.id,
        scope: kind === "ban" ? "ban" : "other",
        actor: admin.identityId,
        at: T,
      });
    };
    await lifted("ban");
    await lifted("suspend");
    await lifted("shadow_ban");
    await lifted("warn");
    const openBan = await applySanction(ctx.client, input(a.accountId, "ban"));
    const openSuspension = await applySanction(ctx.client, input(a.accountId, "suspend"));
    await applySanction(ctx.client, input(a.accountId, "shadow_ban"));
    await applySanction(ctx.client, input(a.accountId, "warn"));
    const theirs = await applySanction(ctx.client, input(b.accountId, "warn"));

    expect(await deleteSanctionsOfAccount(ctx.client, a.accountId)).toBe(6);
    const { rows } = await ctx.client.query<{ id: string }>(
      "SELECT id FROM sanction WHERE account_id = ANY($1::uuid[]) ORDER BY id",
      [[a.accountId, b.accountId]],
    );
    expect(rows.map((row) => row.id)).toEqual([openBan.id, openSuspension.id, theirs.id].sort());
  });
});
