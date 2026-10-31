import { randomBytes } from "node:crypto";
import type { Queryable } from "@kuutti/db";
import { AdminAccount, type AdminAuditRow, ProfileFields, PromptAnswer } from "@kuutti/schema";
import type { QueryResultRow } from "pg";
import { vi } from "vitest";
import { type App, createApp } from "../app.ts";
import { eraseAccount } from "../identity/index.ts";
import { type Staff, signedInAccount, staffSession } from "../test/account.ts";
import {
  test as base,
  captureLogger,
  describe,
  expect,
  type LogLine,
  type TestContext,
  testConfig,
} from "../test/harness.ts";
import { testMediaDeps } from "../test/media.ts";
import { pondNamed } from "../test/people.ts";
import { recorder } from "../test/recorder.ts";
import { accountPage } from "./accounts.ts";
import { applySanction, liftSanction } from "./sanctions.ts";

// A person's page in the panel (#306): GET /admin/accounts/{id} through the
// app. Every field of a seeded person exactly; what the page never carries
// (the hash, the broker's ids, the research id, the e-mail, the photo check's
// notes, staff's words); the audit section's subjects and bounds; one
// account.view row per open, written before the page is read; the tombstone;
// the guard, the roles, the 400 and the 404s; the log line. Real Postgres in
// one rolled-back transaction per test, the routes' clock fixed; the order of
// the statements is read through a recording Queryable, never by sleeping.

/** The routes' clock: 12:00 in Finland on a Tuesday. */
const T = new Date("2026-10-20T09:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (offset: number) => new Date(T.getTime() + offset);
const iso = (offset: number) => at(offset).toISOString();
/** A suspension to 22.10.2026 ends at the start of that day in Finland (summer time, UTC+3). */
const SUSPENSION_ENDS = "2026-10-21T21:00:00.000Z";
const REGISTERED = "2026-09-01T10:00:00.000Z";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000306";

// The marks are letters no id, hash, token or request id is made of.
const MARK = "zqxjv";
const NOTE = `staff note ${MARK}: the same opener to forty people in an hour`;
const EMAIL = `aino.${MARK}@example.test`;
const BROKER_SUBJECT = `subject-${MARK}-1`;
const BROKER_SESSION_INDEX = `session-index-${MARK}-2`;
const BROKER_TOKEN_ID = `token-id-${MARK}-3`;
/** The photo check's kind on the seeded note: no rejection reason shares the word. */
const CHECK_KIND = "disturbing";

const DISPLAY_NAME = "Aino";
const BIO = "Sauna on Saturdays, then the lake whatever the weather.";
const PROMPTS: PromptAnswer[] = [
  PromptAnswer.parse({ key: "sunday", answer: "A long walk and a longer breakfast." }),
  PromptAnswer.parse({ key: "teach_me", answer: "How to bake rye bread that rises." }),
];
const BUG_TEXT = "The photos screen shows yesterday's tip again.";
const IDEA_TEXT = "Let me pick the language of the app myself.";

/** Card fields, special-category ones among them, and three the card leaves out (soft, soft, a setting). */
const FIELDS = ProfileFields.parse({
  intent: "long_term",
  languages: ["fi", "en"],
  height: 172,
  field: ["science"],
  hideFromField: false,
  politics: ["vihr"],
  religion: "agnostic",
  zodiac: "corgi",
  education: "amk",
  drinking: "socially",
});
/** What the card shows of FIELDS (ADR-019 §2): what is there to be seen and what both sides matched on. */
const CARD = {
  intent: "long_term",
  languages: ["fi", "en"],
  height: 172,
  field: ["science"],
  politics: ["vihr"],
  religion: "agnostic",
  zodiac: "corgi",
};

type Headers = Record<string, string>;
type Api = { app: App; logs: () => LogLine[] };

async function apiOn(db: Queryable): Promise<Api> {
  const { logger, lines } = await captureLogger();
  const app = createApp({
    config: testConfig(),
    logger,
    db,
    media: testMediaDeps().deps,
    now: () => T,
  });
  return { app, logs: lines };
}

const test = base.extend<{ api: Api }>({
  api: async ({ ctx }, use) => {
    await use(await apiOn(ctx.client));
  },
});

const open = (api: Api, headers: Headers, id: string) =>
  api.app.request(`/admin/accounts/${id}`, { headers });
const viewCard = (api: Api, headers: Headers, photoId: string) =>
  api.app.request(`/admin/photos/${photoId}/card`, { headers });

/** The raw answer, held to the contract; raw so that a key the contract does not name fails toEqual. */
async function pageOf(response: Response): Promise<AdminAccount> {
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  AdminAccount.parse(body);
  return body as AdminAccount;
}

async function refused(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
}

async function one<R extends QueryResultRow>(
  ctx: TestContext,
  sql: string,
  params: unknown[] = [],
): Promise<R> {
  const { rows } = await ctx.client.query<R>(sql, params);
  const row = rows[0];
  if (!row) throw new Error(`no row from: ${sql}`);
  return row;
}

/** The transaction's now(): what audit_log.at defaults to for every row written in this test. */
async function txNow(ctx: TestContext): Promise<string> {
  return (await one<{ now: Date }>(ctx, "SELECT now() AS now")).now.toISOString();
}

/** Who looked at this account's page, one row per look. */
async function viewsOf(ctx: TestContext, accountId: string) {
  const { rows } = await ctx.client.query<{
    actor_identity_id: string;
    subject_type: string;
    detail: unknown;
  }>(
    `SELECT actor_identity_id, subject_type, detail FROM audit_log
     WHERE action = 'account.view' AND subject_id = $1`,
    [accountId],
  );
  return rows;
}

async function auditCount(ctx: TestContext): Promise<number> {
  return Number((await one<{ n: string }>(ctx, "SELECT count(*) AS n FROM audit_log")).n);
}

const linesOf = (api: Api, msg: string) => api.logs().filter((line) => line.msg === msg);

async function photoOf(
  ctx: TestContext,
  accountId: string,
  input: {
    state: "pending" | "queued" | "approved" | "rejected";
    position: number;
    createdAt: Date;
    rejectionReason?: string;
    appealable?: boolean;
  },
): Promise<{ id: string; key: string }> {
  const key = `k306-${randomBytes(8).toString("hex")}`;
  const { id } = await one<{ id: string }>(
    ctx,
    `INSERT INTO photo (account_id, key, blurhash, width, height, state, rejection_reason, appealable, position, created_at)
     VALUES ($1, $2, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 800, 1067, $3, $4, $5, $6, $7) RETURNING id`,
    [
      accountId,
      key,
      input.state,
      input.rejectionReason ?? null,
      input.appealable ?? false,
      input.position,
      input.createdAt,
    ],
  );
  return { id, key };
}

async function feedbackOf(
  ctx: TestContext,
  accountId: string,
  kind: "bug" | "idea",
  text: string,
  createdAt: Date,
): Promise<string> {
  const { id } = await one<{ id: string }>(
    ctx,
    `INSERT INTO feedback (account_id, kind, text, app_version, platform, locale, created_at)
     VALUES ($1, $2, $3, '0.22.0', 'ios', 'fi', $4) RETURNING id`,
    [accountId, kind, text, createdAt],
  );
  return id;
}

async function profileOf(
  ctx: TestContext,
  accountId: string,
  fields: ProfileFields = FIELDS,
): Promise<void> {
  await ctx.client.query(
    `INSERT INTO profile (account_id, display_name, bio, fields, prompts)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [accountId, DISPLAY_NAME, BIO, JSON.stringify(fields), JSON.stringify(PROMPTS)],
  );
}

/** Registered at a fixed instant, so the page's date can be compared exactly. */
async function registered(ctx: TestContext, accountId: string): Promise<void> {
  await ctx.client.query("UPDATE account SET registered_at = $2 WHERE id = $1", [
    accountId,
    REGISTERED,
  ]);
}

/**
 * A person with everything the page shows and everything it must not: an
 * identity with the broker's ids, an e-mail, a research id, a pond, a profile
 * with special-category answers, two photos (one rejected with a check note),
 * two feedback rows (one handled through the panel), a shadow ban applied and
 * lifted, a suspension that stays, and a moderator's look at the rejected
 * picture through the panel.
 */
async function seededPerson(ctx: TestContext, api: Api, moderator: Staff) {
  const person = await signedInAccount(ctx.client);
  const pondSlug = `p306-${randomBytes(4).toString("hex")}`;
  const pondId = await pondNamed(ctx.client, pondSlug);
  await registered(ctx, person.accountId);
  // October: the month of the clock, which counts as had (36, not 35).
  await ctx.client.query(
    `UPDATE account SET birth_year = 1990, birth_month = 10, gender = 'woman', pond_id = $2, email = $3
     WHERE id = $1`,
    [person.accountId, pondId, EMAIL],
  );
  const { hetu_hmac: hetuHmac } = await one<{ hetu_hmac: string }>(
    ctx,
    `UPDATE identity SET broker_subject = $2, broker_session_index = $3, broker_token_id = $4,
       authenticated_at = $5
     WHERE id = (SELECT identity_id FROM account WHERE id = $1) RETURNING hetu_hmac`,
    [person.accountId, BROKER_SUBJECT, BROKER_SESSION_INDEX, BROKER_TOKEN_ID, REGISTERED],
  );
  const { research_id: researchId } = await one<{ research_id: string }>(
    ctx,
    "INSERT INTO research_subject (account_id, consent_version) VALUES ($1, 'v1') RETURNING research_id",
    [person.accountId],
  );
  await profileOf(ctx, person.accountId);
  const approved = await photoOf(ctx, person.accountId, {
    state: "approved",
    position: 0,
    createdAt: at(-30 * DAY),
  });
  const rejected = await photoOf(ctx, person.accountId, {
    state: "rejected",
    position: 1,
    createdAt: at(-29 * DAY),
    rejectionReason: "other",
    appealable: true,
  });
  const { id: noteId } = await one<{ id: string }>(
    ctx,
    "INSERT INTO photo_check_note (account_id, photo_id, kind, at) VALUES ($1, $2, $3, $4) RETURNING id",
    [person.accountId, rejected.id, CHECK_KIND, at(-29 * DAY)],
  );
  const bug = await feedbackOf(ctx, person.accountId, "bug", BUG_TEXT, at(-3 * DAY));
  await feedbackOf(ctx, person.accountId, "idea", IDEA_TEXT, at(-2 * DAY));
  // A moderator reads the bug report in the panel: handled at the routes' clock.
  const handled = await api.app.request(`/admin/feedback/${bug}/handled`, {
    method: "POST",
    headers: moderator.headers,
  });
  expect(handled.status).toBe(200);
  const shadow = await applySanction(ctx.client, {
    accountId: person.accountId,
    kind: "shadow_ban",
    reason: "scraping",
    note: NOTE,
    actor: moderator.identityId,
    at: at(-3 * HOUR),
  });
  await liftSanction(ctx.client, {
    sanctionId: shadow.id,
    scope: "other",
    actor: moderator.identityId,
    at: at(-2 * HOUR),
  });
  const suspension = await applySanction(ctx.client, {
    accountId: person.accountId,
    kind: "suspend",
    reason: "misrepresentation",
    note: NOTE,
    endsOn: "2026-10-22",
    actor: moderator.identityId,
    at: at(-HOUR),
  });
  expect((await viewCard(api, moderator.headers, rejected.id)).status).toBe(200);
  return {
    person,
    bug,
    pondName: `Pond ${pondSlug}`,
    hetuHmac,
    researchId,
    approved,
    rejected,
    noteId,
    shadow,
    suspension,
  };
}

describe("GET /admin/accounts/{id}", () => {
  test("answers every field of a seeded person exactly", async ({ ctx, api }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const admin = await staffSession(ctx.client, "admin");
    const s = await seededPerson(ctx, api, moderator);
    const id = s.person.accountId;

    const { audit, ...page } = await pageOf(await open(api, admin.headers, id));

    expect(page).toEqual({
      id,
      state: "suspended",
      stateChangedAt: iso(-HOUR),
      registeredAt: REGISTERED,
      deletedAt: null,
      standing: "suspended",
      standingChangedAt: iso(-HOUR),
      suspensionEndsAt: SUSPENSION_ENDS,
      age: 36,
      gender: "woman",
      pond: s.pondName,
      profile: {
        displayName: DISPLAY_NAME,
        bio: BIO,
        bioPreset: null,
        prompts: PROMPTS,
        fields: CARD,
      },
      photos: [
        {
          id: s.approved.id,
          state: "approved",
          rejectionReason: null,
          appealable: false,
          uploadedAt: iso(-30 * DAY),
        },
        {
          id: s.rejected.id,
          state: "rejected",
          rejectionReason: "other",
          appealable: true,
          uploadedAt: iso(-29 * DAY),
        },
      ],
      feedback: [
        { at: iso(-2 * DAY), kind: "idea", text: IDEA_TEXT, handledAt: null },
        { at: iso(-3 * DAY), kind: "bug", text: BUG_TEXT, handledAt: T.toISOString() },
      ],
    });
    // Every row written here shares the transaction's now(), so their order
    // among themselves is the id's; the section's order is its own test.
    const now = await txNow(ctx);
    const row = (
      actor: Staff,
      action: string,
      subjectType: string,
      subjectId: string,
      detail: AdminAuditRow["detail"],
    ): AdminAuditRow => ({
      at: now,
      actorIdentityId: actor.identityId,
      action,
      subjectType,
      subjectId,
      detail,
    });
    const expected = [
      row(moderator, "sanction.apply", "account", id, {
        sanctionId: s.shadow.id,
        kind: "shadow_ban",
        reason: "scraping",
      }),
      row(moderator, "sanction.lift", "account", id, {
        sanctionId: s.shadow.id,
        kind: "shadow_ban",
        reason: "scraping",
      }),
      row(moderator, "sanction.apply", "account", id, {
        sanctionId: s.suspension.id,
        kind: "suspend",
        reason: "misrepresentation",
      }),
      row(moderator, "photo.view", "photo", s.rejected.id, { variant: "card", state: "rejected" }),
      // This open's own row: written before the page was read.
      row(admin, "account.view", "account", id, null),
    ];
    expect(audit).toHaveLength(expected.length);
    expect(audit).toEqual(expect.arrayContaining(expected));
  });

  test("carries none of the hash, the broker's ids, the research id, the e-mail, the photo check's note or staff's words", async ({
    ctx,
    api,
  }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const s = await seededPerson(ctx, api, moderator);
    const response = await open(api, moderator.headers, s.person.accountId);
    expect(response.status).toBe(200);
    const text = await response.text();
    AdminAccount.parse(JSON.parse(text));
    for (const [what, value] of [
      ["hetu_hmac", s.hetuHmac],
      ["broker_subject", BROKER_SUBJECT],
      ["broker_session_index", BROKER_SESSION_INDEX],
      ["broker_token_id", BROKER_TOKEN_ID],
      ["research_id", s.researchId],
      ["the e-mail", EMAIL],
      ["the photo check note's kind", CHECK_KIND],
      ["the photo check note's id", s.noteId],
      ["staff's note on a sanction", MARK],
      ["a photo's object key", s.approved.key],
      ["a photo's object key", s.rejected.key],
    ] as const) {
      expect(text, what).not.toContain(value);
    }
    expect(text).not.toMatch(/hetu|broker|research|mail|check_?note|sanctioned_?from/i);
  });

  test("lists the audit rows about the account and its photos, and none about another person or the person's feedback", async ({
    ctx,
    api,
  }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const admin = await staffSession(ctx.client, "admin");
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const aPhoto = await photoOf(ctx, a.accountId, {
      state: "queued",
      position: 0,
      createdAt: at(-DAY),
    });
    const bPhoto = await photoOf(ctx, b.accountId, {
      state: "queued",
      position: 0,
      createdAt: at(-DAY),
    });
    const aFeedback = await feedbackOf(ctx, a.accountId, "bug", BUG_TEXT, at(-DAY));
    // About b: a look at the page, a look at the picture, a sanction.
    expect((await open(api, admin.headers, b.accountId)).status).toBe(200);
    expect((await viewCard(api, moderator.headers, bPhoto.id)).status).toBe(200);
    const onB = await applySanction(ctx.client, {
      accountId: b.accountId,
      kind: "shadow_ban",
      reason: "scraping",
      note: NOTE,
      actor: moderator.identityId,
      at: at(-HOUR),
    });
    // About a's feedback: the subject is the feedback, not the person.
    const handled = await api.app.request(`/admin/feedback/${aFeedback}/handled`, {
      method: "POST",
      headers: moderator.headers,
    });
    expect(handled.status).toBe(200);
    // About a: a look at the picture.
    expect((await viewCard(api, moderator.headers, aPhoto.id)).status).toBe(200);

    const now = await txNow(ctx);
    const aPage = await pageOf(await open(api, moderator.headers, a.accountId));
    expect(aPage.audit).toHaveLength(2);
    expect(aPage.audit).toEqual(
      expect.arrayContaining([
        {
          at: now,
          actorIdentityId: moderator.identityId,
          action: "photo.view",
          subjectType: "photo",
          subjectId: aPhoto.id,
          detail: { variant: "card", state: "queued" },
        },
        {
          at: now,
          actorIdentityId: moderator.identityId,
          action: "account.view",
          subjectType: "account",
          subjectId: a.accountId,
          detail: null,
        },
      ]),
    );
    const bPage = await pageOf(await open(api, moderator.headers, b.accountId));
    expect(bPage.audit.map((r) => [r.action, r.subjectId, r.actorIdentityId]).sort()).toEqual(
      [
        ["account.view", b.accountId, admin.identityId],
        ["account.view", b.accountId, moderator.identityId],
        ["photo.view", bPhoto.id, moderator.identityId],
        ["sanction.apply", b.accountId, moderator.identityId],
      ].sort(),
    );
    expect(bPage.audit.find((r) => r.action === "sanction.apply")?.detail).toEqual({
      sanctionId: onB.id,
      kind: "shadow_ban",
      reason: "scraping",
    });
  });

  test("lists the newest fifty audit rows, the newest first, account and photo rows together", async ({
    ctx,
    api,
  }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const person = await signedInAccount(ctx.client);
    const photo = await photoOf(ctx, person.accountId, {
      state: "approved",
      position: 0,
      createdAt: at(-DAY),
    });
    // Fifty rows a minute apart in 2020, alternating the account and its
    // photo; this open's account.view is now(), newer than all of them, so
    // the oldest seeded row is the one past the fifty: one page of #309's.
    const start = new Date("2020-01-01T00:00:00Z");
    await ctx.client.query(
      `INSERT INTO audit_log (at, actor_identity_id, action, subject_type, subject_id)
       SELECT $1::timestamptz + g * interval '1 minute', $2,
         CASE WHEN g % 2 = 0 THEN 'sanction.review' ELSE 'photo.view' END,
         CASE WHEN g % 2 = 0 THEN 'account' ELSE 'photo' END,
         CASE WHEN g % 2 = 0 THEN $3::uuid ELSE $4::uuid END
       FROM generate_series(0, 49) AS g`,
      [start, moderator.identityId, person.accountId, photo.id],
    );
    const { audit } = await pageOf(await open(api, moderator.headers, person.accountId));
    expect(audit).toHaveLength(50);
    expect(audit[0]).toMatchObject({
      action: "account.view",
      actorIdentityId: moderator.identityId,
      at: await txNow(ctx),
    });
    const seeded = Array.from({ length: 49 }, (_, i) => 49 - i).map((g) => ({
      at: new Date(start.getTime() + g * 60_000).toISOString(),
      actorIdentityId: moderator.identityId,
      action: g % 2 === 0 ? "sanction.review" : "photo.view",
      subjectType: g % 2 === 0 ? "account" : "photo",
      subjectId: g % 2 === 0 ? person.accountId : photo.id,
      detail: null,
    }));
    expect(audit.slice(1)).toEqual(seeded);
  });

  test("lists at most fifty photos in the owner's order and the newest hundred feedback rows", async ({
    ctx,
    api,
  }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const person = await signedInAccount(ctx.client);
    const { rows: photos } = await ctx.client.query<{ id: string }>(
      `INSERT INTO photo (account_id, key, blurhash, width, height, state, position, created_at)
       SELECT $1, 'k306-' || g, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 800, 1067, 'approved', g,
         $2::timestamptz + g * interval '1 minute'
       FROM generate_series(0, 50) AS g ORDER BY g RETURNING id`,
      [person.accountId, at(-DAY)],
    );
    await ctx.client.query(
      `INSERT INTO feedback (account_id, kind, text, app_version, platform, locale, created_at)
       SELECT $1, 'idea', 'idea number ' || g, '0.22.0', 'android', 'sv',
         $2::timestamptz + g * interval '1 minute'
       FROM generate_series(0, 100) AS g`,
      [person.accountId, at(-DAY)],
    );
    const page = await pageOf(await open(api, moderator.headers, person.accountId));
    expect(photos).toHaveLength(51);
    expect(page.photos.map((p) => p.id)).toEqual(photos.slice(0, 50).map((p) => p.id));
    expect(page.feedback).toHaveLength(100);
    expect(page.feedback[0]).toEqual({
      at: iso(-DAY + 100 * 60_000),
      kind: "idea",
      text: "idea number 100",
      handledAt: null,
    });
    expect(page.feedback.map((f) => f.text)).toEqual(
      Array.from({ length: 100 }, (_, i) => `idea number ${100 - i}`),
    );
  });

  test("answers the nulls and empty sections of an account with nothing answered yet", async ({
    ctx,
    api,
  }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const person = await signedInAccount(ctx.client, undefined, { state: "registered" });
    await registered(ctx, person.accountId);
    const page = await pageOf(await open(api, moderator.headers, person.accountId));
    expect(page).toEqual({
      id: person.accountId,
      state: "registered",
      stateChangedAt: null,
      registeredAt: REGISTERED,
      deletedAt: null,
      standing: "ok",
      standingChangedAt: null,
      suspensionEndsAt: null,
      // June 1990 at October 2026.
      age: 36,
      gender: null,
      pond: null,
      profile: null,
      photos: [],
      feedback: [],
      audit: [
        {
          at: await txNow(ctx),
          actorIdentityId: moderator.identityId,
          action: "account.view",
          subjectType: "account",
          subjectId: person.accountId,
          detail: null,
        },
      ],
    });
  });

  test.for([
    ["no birth year", "birth_year"],
    ["no birth month", "birth_month"],
  ] as const)("answers no age for an account with %s", async ([, column], { ctx, api }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const person = await signedInAccount(ctx.client);
    await ctx.client.query(`UPDATE account SET ${column} = NULL WHERE id = $1`, [person.accountId]);
    const page = await pageOf(await open(api, moderator.headers, person.accountId));
    expect(page.age).toBeNull();
  });

  test("reads the age by the server's clock when the app is handed none", async ({ ctx }) => {
    // Only Date is faked, to a January when June 1990 makes 39 and the real date would not.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2030-01-15T10:00:00Z"));
      const moderator = await staffSession(ctx.client, "moderator");
      const person = await signedInAccount(ctx.client);
      // The harness's app: no `now`, no media.
      const response = await ctx.app.request(`/admin/accounts/${person.accountId}`, {
        headers: moderator.headers,
      });
      expect((await pageOf(response)).age).toBe(39);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the page's builder answers null for an id that is no account's", async ({ ctx }) => {
    expect(await accountPage(ctx.client, UNKNOWN_ID, T)).toBeNull();
  });

  test("leaves out the field of study the person hides from the card, as the card does (#150)", async ({
    ctx,
    api,
  }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const person = await signedInAccount(ctx.client);
    await profileOf(
      ctx,
      person.accountId,
      ProfileFields.parse({ intent: "long_term", field: ["science"], hideFromField: true }),
    );
    const page = await pageOf(await open(api, moderator.headers, person.accountId));
    // The issue: "the card's own presenter, so the moderator sees what others see".
    expect(page.profile?.fields).toEqual({ intent: "long_term" });
  });

  test("leaves out the answers the person hides from the card, as the card does (#515)", async ({
    ctx,
    api,
  }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const person = await signedInAccount(ctx.client);
    await profileOf(
      ctx,
      person.accountId,
      ProfileFields.parse({ intent: "long_term", smoking: "never" }),
    );
    await ctx.client.query("UPDATE profile SET hidden_fields = '{smoking}' WHERE account_id = $1", [
      person.accountId,
    ]);
    const page = await pageOf(await open(api, moderator.headers, person.accountId));
    expect(page.profile?.fields).toEqual({ intent: "long_term" });
  });

  test("shows a ready bio line as the card does, when the person chose one instead of their words", async ({
    ctx,
    api,
  }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const person = await signedInAccount(ctx.client);
    await profileOf(ctx, person.accountId, ProfileFields.parse({ intent: "long_term" }));
    await ctx.client.query("UPDATE profile SET bio = NULL, bio_preset = $2 WHERE account_id = $1", [
      person.accountId,
      "lazy_nice_fellow",
    ]);
    const page = await pageOf(await open(api, moderator.headers, person.accountId));
    expect(page.profile).toMatchObject({ bio: null, bioPreset: "lazy_nice_fellow" });
  });

  test("shows a shadow-banned account as shadow_banned to staff, its standing untouched", async ({
    ctx,
    api,
  }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const person = await signedInAccount(ctx.client);
    await applySanction(ctx.client, {
      accountId: person.accountId,
      kind: "shadow_ban",
      reason: "scraping",
      note: NOTE,
      actor: moderator.identityId,
      at: at(-HOUR),
    });
    const page = await pageOf(await open(api, moderator.headers, person.accountId));
    expect(page).toMatchObject({
      state: "shadow_banned",
      // Nothing the person can see changed, so neither did the date (ADR-013 §2).
      stateChangedAt: null,
      standing: "ok",
      standingChangedAt: null,
      suspensionEndsAt: null,
    });
  });

  test("a tombstone answers its deletion date and nothing else, though its identity is suspended", async ({
    ctx,
    api,
  }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const person = await signedInAccount(ctx.client);
    await registered(ctx, person.accountId);
    await profileOf(ctx, person.accountId);
    await feedbackOf(ctx, person.accountId, "bug", BUG_TEXT, at(-DAY));
    await applySanction(ctx.client, {
      accountId: person.accountId,
      kind: "suspend",
      reason: "misrepresentation",
      note: NOTE,
      endsOn: "2026-10-22",
      actor: moderator.identityId,
      at: at(-HOUR),
    });
    const { logger } = await captureLogger();
    await eraseAccount({ db: ctx.client, logger, now: () => T }, person.accountId);

    const page = await pageOf(await open(api, moderator.headers, person.accountId));
    expect(page).toEqual({
      id: person.accountId,
      state: "deleted",
      stateChangedAt: null,
      registeredAt: null,
      deletedAt: T.toISOString(),
      // The open suspension outlives the erasure and binds the identity
      // (ADR-024 §8), but the tombstone's page does not say so: the standing
      // would tie it to the person's next account (#306).
      standing: null,
      standingChangedAt: null,
      suspensionEndsAt: null,
      age: null,
      gender: null,
      pond: null,
      profile: null,
      photos: [],
      feedback: [],
      // The rows exist, the sanction's and this look's; a tombstone shows none of them.
      audit: [],
    });
    const { n } = await one<{ n: string }>(
      ctx,
      "SELECT count(*) AS n FROM audit_log WHERE subject_type = 'account' AND subject_id = $1",
      [person.accountId],
    );
    expect(Number(n)).toBe(2);
    expect(await viewsOf(ctx, person.accountId)).toEqual([
      { actor_identity_id: moderator.identityId, subject_type: "account", detail: null },
    ]);
  });

  test("carries no picture: one is fetched only on request, and that look is a photo.view row", async ({
    ctx,
    api,
  }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const person = await signedInAccount(ctx.client);
    const photo = await photoOf(ctx, person.accountId, {
      state: "approved",
      position: 0,
      createdAt: at(-DAY),
    });
    const first = await open(api, moderator.headers, person.accountId);
    const text = await first.text();
    expect(first.status).toBe(200);
    expect(text).not.toContain(photo.key);
    expect(text).not.toMatch(/https?:|blurhash|LEHV6nWB2yk8pyo0adR/);
    const photoViews = async () =>
      Number(
        (
          await one<{ n: string }>(
            ctx,
            "SELECT count(*) AS n FROM audit_log WHERE action = 'photo.view' AND subject_id = $1",
            [photo.id],
          )
        ).n,
      );
    expect(await photoViews()).toBe(0);

    expect((await viewCard(api, moderator.headers, photo.id)).status).toBe(200);
    expect(await photoViews()).toBe(1);
    const { audit } = await pageOf(await open(api, moderator.headers, person.accountId));
    expect(audit.filter((r) => r.action === "photo.view")).toEqual([
      {
        at: await txNow(ctx),
        actorIdentityId: moderator.identityId,
        action: "photo.view",
        subjectType: "photo",
        subjectId: photo.id,
        detail: { variant: "card", state: "approved" },
      },
    ]);
  });
});

describe("the account.view row", () => {
  test("is written once per open, each naming who looked", async ({ ctx, api }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const admin = await staffSession(ctx.client, "admin");
    const person = await signedInAccount(ctx.client);
    for (const staff of [moderator, moderator, admin]) {
      expect((await open(api, staff.headers, person.accountId)).status).toBe(200);
    }
    const views = await viewsOf(ctx, person.accountId);
    expect(views.map((v) => v.actor_identity_id).sort()).toEqual(
      [moderator.identityId, moderator.identityId, admin.identityId].sort(),
    );
    expect(views.map(({ subject_type, detail }) => ({ subject_type, detail }))).toEqual(
      Array(3).fill({ subject_type: "account", detail: null }),
    );
    expect(linesOf(api, "account viewed")).toHaveLength(3);
  });

  /**
   * A Queryable that writes down every statement it passes on. With `refuse`,
   * the account.view insert goes to Postgres with an actor no identity has, so
   * the database refuses it by its foreign key, as any failed write would be.
   */
  /** What building the page reads; each must come after the audit row. */
  const PAGE_READS = [
    ["the account row", /SELECT \* FROM account WHERE id/],
    ["the identity's standing", /SELECT standing, standing_changed_at/],
    ["the profile", /FROM profile WHERE account_id/],
    ["the photos", /FROM photo WHERE account_id/],
    ["the pond", /JOIN ponds/],
    ["the feedback", /FROM feedback WHERE account_id/],
    ["the audit rows", /FROM audit_log\s+WHERE/],
  ] as const;
  const AUDIT_INSERT = /INSERT INTO public\.audit_log/;
  const EXISTS = /SELECT 1 FROM account WHERE id/;

  test("is written before any of the page is read", async ({ ctx }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const person = await signedInAccount(ctx.client);
    const spy = recorder(ctx.client);
    const api = await apiOn(spy.db);
    expect((await open(api, moderator.headers, person.accountId)).status).toBe(200);
    const insert = spy.statements.findIndex((s) => AUDIT_INSERT.test(s));
    expect(insert).toBeGreaterThan(spy.statements.findIndex((s) => EXISTS.test(s)));
    expect(spy.statements.findIndex((s) => EXISTS.test(s))).toBeGreaterThanOrEqual(0);
    for (const [what, pattern] of PAGE_READS) {
      const first = spy.statements.findIndex((s) => pattern.test(s));
      expect(first, `${what} is read`).toBeGreaterThanOrEqual(0);
      expect(first, `${what} is read after the audit row`).toBeGreaterThan(insert);
    }
  });

  test("a look whose row is refused does not happen: no page, no row, no log line", async ({
    ctx,
  }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const person = await signedInAccount(ctx.client);
    await profileOf(ctx, person.accountId);
    await feedbackOf(ctx, person.accountId, "bug", BUG_TEXT, at(-DAY));
    const spy = recorder(ctx.client, "account.view");
    const api = await apiOn(spy.db);
    const response = await open(api, moderator.headers, person.accountId);
    const text = await response.text();
    expect(response.status).toBe(500);
    expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe("internal_error");
    for (const value of [person.accountId, DISPLAY_NAME, BIO, BUG_TEXT]) {
      expect(text).not.toContain(value);
    }
    expect(spy.statements.some((s) => AUDIT_INSERT.test(s))).toBe(true);
    for (const [what, pattern] of PAGE_READS) {
      expect(
        spy.statements.some((s) => pattern.test(s)),
        `${what} is never read`,
      ).toBe(false);
    }
    expect(await viewsOf(ctx, person.accountId)).toEqual([]);
    expect(linesOf(api, "account viewed")).toEqual([]);
    expect(linesOf(api, "unhandled error")).toHaveLength(1);
  });
});

describe("refusals", () => {
  test.for([
    ["an id nobody has", () => UNKNOWN_ID],
    ["a photo's id", (ids: { photo: string; staff: string }) => ids.photo],
    ["a member of staff's identity id", (ids: { photo: string; staff: string }) => ids.staff],
  ] as const)("%s is not_found, and no row is written", async ([, idOf], { ctx, api }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const owner = await signedInAccount(ctx.client);
    const photo = await photoOf(ctx, owner.accountId, {
      state: "approved",
      position: 0,
      createdAt: at(-DAY),
    });
    const id = idOf({ photo: photo.id, staff: moderator.identityId });
    const before = await auditCount(ctx);
    await refused(await open(api, moderator.headers, id), 404, "not_found");
    expect(await auditCount(ctx)).toBe(before);
    expect(await viewsOf(ctx, id)).toEqual([]);
    expect(linesOf(api, "account viewed")).toEqual([]);
  });

  test.for([
    ["a number", "42"],
    ["a word", "not-a-uuid"],
    ["a uuid's shape without its variant", "12345678-1234-1234-1234-123456789012"],
    ["a uuid with one character more", `${UNKNOWN_ID}0`],
  ] as const)("%s is validation_failed, and no row is written", async ([, id], { ctx, api }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const before = await auditCount(ctx);
    await refused(await open(api, moderator.headers, id), 400, "validation_failed");
    expect(await auditCount(ctx)).toBe(before);
    expect(linesOf(api, "request validation failed")).toHaveLength(1);
    expect(linesOf(api, "account viewed")).toEqual([]);
  });

  test("each variant of a missing or dead session is refused with its own code, and no row is written", async ({
    ctx,
    api,
  }) => {
    const person = await signedInAccount(ctx.client);
    const bystander = await signedInAccount(ctx.client);
    const ended = await staffSession(ctx.client, "admin");
    await ctx.client.query("UPDATE admin_session SET revoked_at = now() WHERE id = $1", [
      ended.sessionId,
    ]);
    const expired = await staffSession(ctx.client, "admin");
    await ctx.client.query(
      "UPDATE admin_session SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [expired.sessionId],
    );
    const demoted = await staffSession(ctx.client, "moderator");
    await ctx.client.query("DELETE FROM moderator_roles WHERE identity_id = $1", [
      demoted.identityId,
    ]);
    const suspendedStaff = await staffSession(ctx.client, "moderator");
    await ctx.client.query("UPDATE identity SET standing = 'suspended' WHERE id = $1", [
      suspendedStaff.identityId,
    ]);
    const before = await auditCount(ctx);
    for (const [what, headers, code] of [
      ["no token", {}, "unauthenticated"],
      ["another scheme", { authorization: `Basic ${"A".repeat(43)}` }, "unauthenticated"],
      ["a malformed token", { authorization: "Bearer not-a-token" }, "unauthenticated"],
      ["an unknown token", { authorization: `Bearer ${"u".repeat(43)}` }, "unauthenticated"],
      ["a product session's token", bystander.headers, "unauthenticated"],
      ["an ended session", ended.headers, "session_revoked"],
      ["a role taken away", demoted.headers, "session_revoked"],
      ["staff no longer in good standing", suspendedStaff.headers, "session_revoked"],
      ["an expired session", expired.headers, "session_expired"],
    ] as const) {
      const response = await open(api, headers, person.accountId);
      expect(response.status, what).toBe(401);
      expect(((await response.json()) as { error: { code: string } }).error.code, what).toBe(code);
    }
    expect(await auditCount(ctx)).toBe(before);
    expect(linesOf(api, "account viewed")).toEqual([]);
  });

  test("the guard answers before the contract is read", async ({ api }) => {
    await refused(await open(api, {}, "not-a-uuid"), 401, "unauthenticated");
  });

  test("a researcher is refused with admin_forbidden, and no row is written", async ({
    ctx,
    api,
  }) => {
    const researcher = await staffSession(ctx.client, "researcher");
    const person = await signedInAccount(ctx.client);
    const before = await auditCount(ctx);
    await refused(await open(api, researcher.headers, person.accountId), 403, "admin_forbidden");
    expect(await auditCount(ctx)).toBe(before);
    expect(linesOf(api, "account viewed")).toEqual([]);
  });

  test.for(["moderator", "admin"] as const)("a %s is let in", async (role, { ctx, api }) => {
    const staff = await staffSession(ctx.client, role);
    const person = await signedInAccount(ctx.client);
    const page = await pageOf(await open(api, staff.headers, person.accountId));
    expect(page.id).toBe(person.accountId);
    expect(await viewsOf(ctx, person.accountId)).toEqual([
      { actor_identity_id: staff.identityId, subject_type: "account", detail: null },
    ]);
  });
});

describe("the log", () => {
  /** pino's own fields on every line. */
  const PINO = new Set(["level", "time", "pid", "hostname", "msg"]);

  test("'account viewed' carries the member of staff and the account only, and no line carries the person", async ({
    ctx,
    api,
  }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const admin = await staffSession(ctx.client, "admin");
    const s = await seededPerson(ctx, api, moderator);
    expect((await open(api, admin.headers, s.person.accountId)).status).toBe(200);
    const viewed = linesOf(api, "account viewed");
    expect(viewed).toHaveLength(1);
    const [line] = viewed;
    expect(line?.level).toBe(30);
    expect(
      Object.fromEntries(Object.entries(line ?? {}).filter(([key]) => !PINO.has(key))),
    ).toEqual({ staffIdentityId: admin.identityId, accountId: s.person.accountId });
    const logged = JSON.stringify(api.logs());
    for (const value of [
      s.hetuHmac,
      s.researchId,
      EMAIL,
      MARK,
      DISPLAY_NAME,
      BIO,
      BUG_TEXT,
      IDEA_TEXT,
      ...PROMPTS.map((p) => p.answer),
    ]) {
      expect(logged).not.toContain(value);
    }
  });
});
