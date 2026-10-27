import { randomUUID } from "node:crypto";
import { type Queryable, transaction } from "@kuutti/db";
import {
  ErrorResponse,
  PhotoUrlResponse,
  ReportDecision,
  ReportDetail,
  ReportQueue,
} from "@kuutti/schema";
import { vi } from "vitest";
import { type App, createApp } from "../app.ts";
import { eraseAccount } from "../identity/index.ts";
import { type MediaDeps, objectKey } from "../media/index.ts";
import { type SignedIn, signedInAccount, staffSession } from "../test/account.ts";
import { cardShown } from "../test/cards.ts";
import { conversationBetween, interleaved, photoMessage } from "../test/chat.ts";
import {
  test as base,
  captureLogger,
  describe,
  expect,
  type TestContext,
  testConfig,
} from "../test/harness.ts";
import { testMediaDeps } from "../test/media.ts";
import { pidOf, waitsFor, watched, withTwoConnections } from "../test/races.ts";
import { recorder } from "../test/recorder.ts";
import { accountOf, reportIn, signedInPeople } from "../test/reports.ts";
import { decideReport } from "./report-queue.ts";
import { listReportsOfAccount } from "./reports.ts";
import { applySanction } from "./sanctions.ts";

// One report worked to a decision (#312, features/safety/report-decision.feature):
// the report opened with its note and its frozen copy after the look's audit
// row, a photo of the copy on request, the decision and the sanctions that
// may name it, two moderators at once, the recusal of a member of staff who
// is a party, and the moderators' guard. Reports whose words are the point
// are filed through the conversation's own route; the rest are written
// straight into the test's transaction, as filing leaves them.

/** The panel's clock: 12:00 in Finland, one Friday. */
const T = new Date("2026-10-16T09:00:00.000Z");
const FILED = "2026-10-15T08:00:00.000Z";
const UNKNOWN = "00000000-0000-4000-8000-000000000312";
const NOTE = "Kysyy aina kotiosoitettani";
const OPENED_AT = new Date("2026-10-15T07:00:00.000Z");

type Headers = Record<string, string>;

async function appOn(db: Queryable, media?: MediaDeps): Promise<App> {
  const { logger } = await captureLogger();
  return createApp({ config: testConfig(), logger, db, now: () => T, media });
}

const test = base.extend<{ app: App }>({
  app: async ({ ctx }, use) => {
    await use(await appOn(ctx.client, testMediaDeps().deps));
  },
});

const open = (app: App, headers: Headers, id: string) =>
  app.request(`/admin/reports/${id}`, { headers });
const photo = (app: App, headers: Headers, id: string, seq: number | string) =>
  app.request(`/admin/reports/${id}/copy/${seq}/photo`, { headers });
const pointedPhoto = (app: App, headers: Headers, id: string) =>
  app.request(`/admin/reports/${id}/photo`, { headers });
const decide = (app: App, headers: Headers, id: string, body: unknown) =>
  app.request(`/admin/reports/${id}/decision`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function opened(app: App, headers: Headers, id: string): Promise<ReportDetail> {
  const response = await open(app, headers, id);
  expect(response.status).toBe(200);
  return ReportDetail.parse(await response.json());
}

async function errorCode(response: Response): Promise<string> {
  return ErrorResponse.parse(await response.json()).error.code;
}

async function auditOf(db: Queryable, action: string) {
  return (
    await db.query(
      `SELECT actor_identity_id, action, subject_type, subject_id, detail
         FROM audit_log WHERE action = $1 ORDER BY at, id`,
      [action],
    )
  ).rows;
}

async function count(db: Queryable, sql: string, params: unknown[] = []): Promise<number> {
  return Number((await db.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0);
}

/** Everything a look or a decision could write, to see that a refusal writes none of it. */
async function written(db: Queryable) {
  return {
    audit: await count(db, "SELECT count(*) AS n FROM audit_log"),
    decided: await count(db, "SELECT count(*) AS n FROM report WHERE decided_at IS NOT NULL"),
    notices: await count(db, "SELECT count(*) AS n FROM notice"),
    events: await count(db, "SELECT count(*) AS n FROM events"),
  };
}

/** A report from the conversation, filed through its own route by the reporter, as the app files it. */
async function fileFrom(ctx: TestContext, reporter: SignedIn, conversationId: string) {
  const answer = await ctx.app.request(`/conversations/${conversationId}/report`, {
    method: "POST",
    headers: { ...reporter.headers, "content-type": "application/json" },
    body: JSON.stringify({ reason: "harassment", note: NOTE }),
  });
  expect(answer.status).toBe(204);
  const { rows } = await ctx.client.query<{ id: string }>(
    "SELECT id FROM report WHERE conversation_id = $1 AND reporter_account_id = $2",
    [conversationId, reporter.accountId],
  );
  return rows[0]?.id as string;
}

/** A's conversation with B, two lines of words, reported by A with a note. */
async function reportedConversation(ctx: TestContext) {
  const [a, b] = await signedInPeople(ctx.client, 2);
  if (!a || !b) throw new Error("people not written");
  const conversationId = await conversationBetween(ctx.client, a.accountId, b.accountId, {
    openedAt: OPENED_AT,
    messages: [
      { from: "a", body: "Moikka, mitä kuuluu?" },
      { from: "b", body: "Missä asut tarkalleen?" },
    ],
  });
  const id = await fileFrom(ctx, a, conversationId);
  return { a, b, conversationId, id };
}

/** A's conversation where B sent a photo, reported by A; the photo's objects are in the store. */
async function reportedPhoto(ctx: TestContext, media: ReturnType<typeof testMediaDeps>) {
  const [a, b] = await signedInPeople(ctx.client, 2);
  if (!a || !b) throw new Error("people not written");
  const conversationId = await conversationBetween(ctx.client, a.accountId, b.accountId, {
    openedAt: OPENED_AT,
    messages: [{ from: "a", body: "Lähetä kuva" }],
  });
  const sent = await photoMessage(ctx.client, {
    conversationId,
    accountId: b.accountId,
    side: "b",
    store: media.store,
  });
  const id = await fileFrom(ctx, a, conversationId);
  return { a, b, id, ...sent };
}

/** A card's report from A about B, filed at FILED, waiting. */
async function cardReport(ctx: TestContext) {
  const [a, b] = await signedInPeople(ctx.client, 2);
  if (!a || !b) throw new Error("people not written");
  const id = await reportIn(ctx.client, a.accountId, b.accountId, FILED);
  return { a, b, id };
}

const warn = (db: Queryable, accountId: string, actor: string | null, at: string) =>
  applySanction(db, {
    accountId,
    kind: "warn",
    reason: "harassment",
    note: "Kept asking for an address.",
    actor,
    at: new Date(at),
  });

const ban = (db: Queryable, accountId: string, actor: string | null, at: string) =>
  applySanction(db, {
    accountId,
    kind: "ban",
    reason: "harassment",
    note: "Threats.",
    actor,
    at: new Date(at),
  });

const erase = async (db: Queryable, accountId: string) =>
  eraseAccount({ db, logger: (await captureLogger()).logger, now: () => new Date() }, accountId);

describe("GET /admin/reports/{id}", () => {
  test("Opening a report from a conversation shows its note and the frozen copy after a conversation.view row", async ({
    ctx,
    app,
  }) => {
    const moderator = await staffSession(ctx.client);
    const { a, b, id } = await reportedConversation(ctx);
    const report = await opened(app, moderator.headers, id);
    expect(report).toMatchObject({
      id,
      source: "conversation",
      note: NOTE,
      outcome: null,
      decidedBy: null,
      sanctionId: null,
      actable: [],
      reporter: { accountId: a.accountId, filed: 1, upheld: 0 },
      reported: { accountId: b.accountId, received: 1, sanctions: 0 },
    });
    expect(report.copy).toEqual([
      {
        seq: 1,
        side: "reporter",
        kind: "text",
        body: "Moikka, mitä kuuluu?",
        photo: false,
        createdAt: "2026-10-15T07:01:00.000Z",
      },
      {
        seq: 2,
        side: "reported",
        kind: "text",
        body: "Missä asut tarkalleen?",
        photo: false,
        createdAt: "2026-10-15T07:02:00.000Z",
      },
    ]);
    const rows = await auditOf(ctx.client, "conversation.view");
    expect(rows).toEqual([
      {
        actor_identity_id: moderator.identityId,
        action: "conversation.view",
        subject_type: "report",
        subject_id: id,
        detail: null,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(a.accountId);
    expect(JSON.stringify(rows)).not.toContain(b.accountId);
    expect(await auditOf(ctx.client, "report.view")).toEqual([]);
  });

  test("Opening a report from a card shows its note after a report.view row", async ({
    ctx,
    app,
  }) => {
    const moderator = await staffSession(ctx.client);
    const { b, id } = await cardReport(ctx);
    await ctx.client.query("UPDATE report SET note = $2 WHERE id = $1", [id, NOTE]);
    const report = await opened(app, moderator.headers, id);
    expect(report).toMatchObject({ id, source: "card", note: NOTE, copy: null });
    expect(report.reported.accountId).toBe(b.accountId);
    expect(await auditOf(ctx.client, "report.view")).toEqual([
      {
        actor_identity_id: moderator.identityId,
        action: "report.view",
        subject_type: "report",
        subject_id: id,
        detail: null,
      },
    ]);
    expect(await auditOf(ctx.client, "conversation.view")).toEqual([]);
  });

  test("A look whose audit row cannot be written sends nothing", async ({ ctx }) => {
    const moderator = await staffSession(ctx.client);
    const { id } = await reportedConversation(ctx);
    const { logger, lines } = await captureLogger();
    const spy = recorder(ctx.client, "conversation.view");
    const app = createApp({ config: testConfig(), logger, db: spy.db, now: () => T });
    const response = await open(app, moderator.headers, id);
    const text = await response.text();
    expect(response.status).toBe(500);
    expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe("internal_error");
    for (const words of [NOTE, "Moikka", "Missä asut"]) expect(text).not.toContain(words);
    const insert = spy.statements.findIndex((s) => /INSERT INTO public\.audit_log/.test(s));
    expect(insert).toBeGreaterThan(0);
    // Neither before the refused row nor after it: the note and the copy were never read.
    expect(spy.statements.some((s) => /report_message|r\.note/.test(s))).toBe(false);
    expect(lines().some((line) => line.msg === "report opened")).toBe(false);
    expect(await auditOf(ctx.client, "conversation.view")).toEqual([]);
  });

  test("the audit row is written after the report is found and before its note and copy are read", async ({
    ctx,
  }) => {
    const moderator = await staffSession(ctx.client);
    const { id } = await reportedConversation(ctx);
    const spy = recorder(ctx.client);
    const app = await appOn(spy.db);
    expect((await open(app, moderator.headers, id)).status).toBe(200);
    const at = (pattern: RegExp) => spy.statements.findIndex((s) => pattern.test(s));
    const found = at(/SELECT r\.source FROM report r/);
    const insert = at(/INSERT INTO public\.audit_log/);
    expect(found).toBeGreaterThanOrEqual(0);
    expect(insert).toBeGreaterThan(found);
    expect(at(/r\.note/)).toBeGreaterThan(insert);
    expect(at(/JOIN report_message rm/)).toBeGreaterThan(insert);
  });

  test("a report pruned between the look's audit row and its read answers 404, and its row goes with the refusal", async ({
    ctx,
  }) => {
    const moderator = await staffSession(ctx.client);
    const { id } = await reportedConversation(ctx);
    // The night's prune, as if it committed just before the note is read.
    const db = interleaved(ctx.client, /r\.note, r\.decided_by/, () =>
      ctx.client.query("DELETE FROM report WHERE id = $1", [id]),
    );
    const response = await open(await appOn(db), moderator.headers, id);
    expect(db.ran()).toBe(true);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not_found");
    expect(await auditOf(ctx.client, "conversation.view")).toEqual([]);
  });

  test("The copy keeps every line, a shadow ban's withheld ones too, after both people are erased", async ({
    ctx,
    app,
  }) => {
    const moderator = await staffSession(ctx.client);
    const [a, b] = await signedInPeople(ctx.client, 2);
    if (!a || !b) throw new Error("people not written");
    const conversationId = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      openedAt: OPENED_AT,
      messages: [
        { from: "a", body: "Hei!" },
        // Written while B's shadow ban stands: withheld from A.
        { from: "b", body: "Vastaa heti", at: new Date("2026-10-15T07:40:00.000Z") },
        { from: "a", body: "Miksi et vastaa?", at: new Date("2026-10-15T07:45:00.000Z") },
      ],
    });
    await applySanction(ctx.client, {
      accountId: b.accountId,
      kind: "shadow_ban",
      reason: "harassment",
      note: "Spam to many.",
      actor: moderator.identityId,
      at: new Date("2026-10-15T07:30:00.000Z"),
    });
    const id = await fileFrom(ctx, a, conversationId);
    await erase(ctx.client, a.accountId);
    await erase(ctx.client, b.accountId);
    // The conversation went with its second person; the copy stays with its report.
    expect(
      await count(ctx.client, "SELECT count(*) AS n FROM conversation WHERE id = $1", [
        conversationId,
      ]),
    ).toBe(0);
    const report = await opened(app, moderator.headers, id);
    expect(report.copy?.map((line) => [line.seq, line.side, line.body])).toEqual([
      [1, "reporter", "Hei!"],
      [2, "reported", "Vastaa heti"],
      [3, "reporter", "Miksi et vastaa?"],
    ]);
  });

  test("a decided report answers its outcome, who decided and with what, and nothing to close it with", async ({
    ctx,
    app,
  }) => {
    const moderator = await staffSession(ctx.client);
    const other = await staffSession(ctx.client);
    const { b, id } = await cardReport(ctx);
    const warned = await warn(
      ctx.client,
      b.accountId,
      other.identityId,
      "2026-10-15T09:00:00.000Z",
    );
    expect(
      (await decide(app, other.headers, id, { outcome: "acted", sanctionId: warned.id })).status,
    ).toBe(200);
    const report = await opened(app, moderator.headers, id);
    expect(report).toMatchObject({
      outcome: "acted",
      decidedAt: T.toISOString(),
      decidedBy: other.identityId,
      sanctionId: warned.id,
      actable: [],
    });
  });

  test("the sanctions that may close a report are those given to the reported person since the filing, newest first", async ({
    ctx,
    app,
  }) => {
    const moderator = await staffSession(ctx.client);
    const admin = await staffSession(ctx.client, "admin");
    const { a, b, id } = await cardReport(ctx);
    const [c] = await signedInPeople(ctx.client, 1);
    if (!c) throw new Error("person not written");
    // Before the filing, on somebody else, and by nobody: none of them.
    await warn(ctx.client, b.accountId, moderator.identityId, "2026-10-15T07:59:59.999Z");
    await warn(ctx.client, c.accountId, moderator.identityId, "2026-10-15T09:00:00.000Z");
    await warn(ctx.client, a.accountId, moderator.identityId, "2026-10-15T09:00:00.000Z");
    await warn(ctx.client, b.accountId, null, "2026-10-15T09:30:00.000Z");
    // At the filing itself, one lifted since, and a ban through an earlier, erased account of B's.
    const atFiling = await warn(ctx.client, b.accountId, moderator.identityId, FILED);
    const lifted = await warn(
      ctx.client,
      b.accountId,
      moderator.identityId,
      "2026-10-15T10:00:00.000Z",
    );
    await ctx.client.query(
      "UPDATE sanction SET lifted_at = '2026-10-15T11:00:00Z', lifted_by = $2 WHERE id = $1",
      [lifted.id, admin.identityId],
    );
    const identity = await ctx.client.query<{ identity_id: string }>(
      "SELECT identity_id FROM account WHERE id = $1",
      [b.accountId],
    );
    const earlier = await accountOf(ctx.client, identity.rows[0]?.identity_id as string, "deleted");
    const banned = await ban(ctx.client, earlier, admin.identityId, "2026-10-15T12:00:00.000Z");
    const report = await opened(app, moderator.headers, id);
    expect(report.actable.map((s) => [s.id, s.kind, s.liftedAt])).toEqual([
      [banned.id, "ban", null],
      [lifted.id, "warn", "2026-10-15T11:00:00.000Z"],
      [atFiling.id, "warn", null],
    ]);
  });

  test("an id that is no uuid is refused with 400, and an unknown one is 404 with no audit row", async ({
    ctx,
    app,
  }) => {
    const moderator = await staffSession(ctx.client);
    const before = await written(ctx.client);
    const bad = await open(app, moderator.headers, "not-a-report");
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe("validation_failed");
    const unknown = await open(app, moderator.headers, UNKNOWN);
    expect(unknown.status).toBe(404);
    expect(await errorCode(unknown)).toBe("not_found");
    expect(await written(ctx.client)).toEqual(before);
  });

  test("a conversation's report with no lines answers an empty copy, and a photo removed before the filing says so", async ({
    ctx,
    app,
  }) => {
    const moderator = await staffSession(ctx.client);
    const [a, b] = await signedInPeople(ctx.client, 2);
    if (!a || !b) throw new Error("people not written");
    const empty = await reportIn(
      ctx.client,
      a.accountId,
      b.accountId,
      FILED,
      undefined,
      "conversation",
    );
    const [c] = await signedInPeople(ctx.client, 1);
    if (!c) throw new Error("person not written");
    const removed = await reportIn(
      ctx.client,
      c.accountId,
      b.accountId,
      FILED,
      undefined,
      "conversation",
    );
    await ctx.client.query(
      `INSERT INTO report_message (report_id, seq, side, kind, body, photo_id, created_at)
       VALUES ($1, 1, 'reported', 'photo', NULL, NULL, $2)`,
      [removed, FILED],
    );
    expect((await opened(app, moderator.headers, empty)).copy).toEqual([]);
    expect((await opened(app, moderator.headers, removed)).copy).toEqual([
      { seq: 1, side: "reported", kind: "photo", body: null, photo: false, createdAt: FILED },
    ]);
  });
});

describe("GET /admin/reports/{id}/copy/{seq}/photo", () => {
  test("A photo of the copy is shown only on request, one photo.view row per look", async ({
    ctx,
  }) => {
    const moderator = await staffSession(ctx.client);
    const media = testMediaDeps();
    const app = await appOn(ctx.client, media.deps);
    const { id, key, photoId, seq } = await reportedPhoto(ctx, media);
    const text = await (await open(app, moderator.headers, id)).text();
    const report = ReportDetail.parse(JSON.parse(text));
    expect(report.copy?.find((line) => line.seq === seq)).toMatchObject({
      kind: "photo",
      photo: true,
    });
    for (const secret of [key, photoId]) expect(text).not.toContain(secret);
    expect(await auditOf(ctx.client, "photo.view")).toEqual([]);

    for (const look of [1, 2]) {
      const response = await photo(app, moderator.headers, id, seq);
      expect(response.status).toBe(200);
      const answer = PhotoUrlResponse.parse(await response.json());
      expect(answer.variant).toBe("full");
      expect(new URL(answer.url).pathname).toBe(`/${objectKey(key, "full")}`);
      expect(answer.expiresAt).toBe(new Date(T.getTime() + 15 * 60 * 1000).toISOString());
      expect((await auditOf(ctx.client, "photo.view")).length).toBe(look);
    }
    expect(await auditOf(ctx.client, "photo.view")).toEqual(
      [1, 2].map(() => ({
        actor_identity_id: moderator.identityId,
        action: "photo.view",
        subject_type: "report",
        subject_id: id,
        detail: { seq, variant: "full" },
      })),
    );
  });

  test("A photo the copy holds is shown after its sender's erasure", async ({ ctx }) => {
    const moderator = await staffSession(ctx.client);
    const media = testMediaDeps();
    const app = await appOn(ctx.client, media.deps);
    const { b, id, key, seq } = await reportedPhoto(ctx, media);
    await erase(ctx.client, b.accountId);
    const response = await photo(app, moderator.headers, id, seq);
    expect(response.status).toBe(200);
    const answer = PhotoUrlResponse.parse(await response.json());
    expect(new URL(answer.url).pathname).toBe(`/${objectKey(key, "full")}`);
  });

  test("a look whose audit row is refused signs nothing", async ({ ctx }) => {
    const moderator = await staffSession(ctx.client);
    const media = testMediaDeps();
    const sign = vi.fn(media.deps.signer.sign);
    const { id, seq } = await reportedPhoto(ctx, media);
    const spy = recorder(ctx.client, "photo.view");
    const app = await appOn(spy.db, { ...media.deps, signer: { sign } });
    const response = await photo(app, moderator.headers, id, seq);
    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe("internal_error");
    // The refused row ended the test's transaction (no savepoint around a single
    // write), so nothing more is asked of it: the signer was never reached.
    expect(sign).not.toHaveBeenCalled();
  });

  test("a line with no photo, a seq past the end, another report's line and an unknown report are 404, and nothing is written", async ({
    ctx,
  }) => {
    const moderator = await staffSession(ctx.client);
    const media = testMediaDeps();
    const app = await appOn(ctx.client, media.deps);
    const first = await reportedPhoto(ctx, media);
    const [c, d] = await signedInPeople(ctx.client, 2);
    if (!c || !d) throw new Error("people not written");
    const plain = await conversationBetween(ctx.client, c.accountId, d.accountId, {
      openedAt: OPENED_AT,
      messages: [{ from: "b", body: "Moi" }],
    });
    const other = await fileFrom(ctx, c, plain);
    await ctx.client.query(
      `INSERT INTO report_message (report_id, seq, side, kind, body, photo_id, created_at)
       VALUES ($1, 9, 'reported', 'photo', NULL, NULL, $2)`,
      [first.id, FILED],
    );
    const before = await written(ctx.client);
    for (const [what, id, seq] of [
      ["a text line", first.id, 1],
      ["a photo removed before the filing", first.id, 9],
      ["a seq past the end", first.id, 50],
      ["another report's line", other, first.seq],
      ["an unknown report", UNKNOWN, first.seq],
    ] as const) {
      const response = await photo(app, moderator.headers, id, seq);
      expect(response.status, what).toBe(404);
      expect(await errorCode(response), what).toBe("not_found");
    }
    expect(await written(ctx.client)).toEqual(before);
  });

  test.for(["0", "-1", "x", String(2 ** 31)])(
    "a seq of %s is refused with 400",
    async (seq, { ctx, app }) => {
      const moderator = await staffSession(ctx.client);
      const response = await photo(app, moderator.headers, UNKNOWN, seq);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("validation_failed");
    },
  );

  test("without object storage the answer is 503 before anything is read, for a party too", async ({
    ctx,
  }) => {
    const m = await staffSession(ctx.client);
    const app = await appOn(ctx.client);
    const mine = await accountOf(ctx.client, m.identityId);
    const [x] = await signedInPeople(ctx.client, 1);
    if (!x) throw new Error("person not written");
    const own = await reportIn(ctx.client, mine, x.accountId, FILED, undefined, "conversation");
    const before = await written(ctx.client);
    for (const id of [own, UNKNOWN]) {
      for (const response of [
        await photo(app, m.headers, id, 1),
        await pointedPhoto(app, m.headers, id),
      ]) {
        expect(response.status).toBe(503);
        expect(await errorCode(response)).toBe("media_unavailable");
      }
    }
    expect(await written(ctx.client)).toEqual(before);
  });
});

/** A's report of B from B's card, pointing at the photo of it A was shown (#476), filed through the route. */
async function pointedCardReport(ctx: TestContext) {
  const [a, b] = await signedInPeople(ctx.client, 2);
  if (!a || !b) throw new Error("people not written");
  const shown = await cardShown(ctx.client, a.accountId, b.accountId);
  const answer = await ctx.app.request("/reports", {
    method: "POST",
    headers: { ...a.headers, "content-type": "application/json" },
    body: JSON.stringify({ accountId: b.accountId, reason: "misrepresentation", photoId: shown }),
  });
  expect(answer.status).toBe(204);
  const { rows } = await ctx.client.query<{ id: string; key: string }>(
    `SELECT r.id, p.key FROM report r JOIN photo p ON p.id = r.photo_id
      WHERE r.reporter_account_id = $1`,
    [a.accountId],
  );
  const row = rows[0];
  if (!row) throw new Error("report not filed with its photo");
  return { a, b, id: row.id, photoId: shown, key: row.key };
}

describe("GET /admin/reports/{id}/photo", () => {
  test("A report from a card can point at a photo of the card the person was shown", async ({
    ctx,
    app,
  }) => {
    const moderator = await staffSession(ctx.client);
    const { id, photoId, key } = await pointedCardReport(ctx);
    const response = await open(app, moderator.headers, id);
    const text = await response.text();
    // The id and the state for a take-down beside it (#477), never the stored key.
    expect(ReportDetail.parse(JSON.parse(text))).toMatchObject({
      source: "card",
      copy: null,
      lineSeq: null,
      pointedPhoto: { removed: false, id: photoId, state: "approved", approvedPhotos: 1 },
    });
    expect(text).not.toContain(key);
    expect(await auditOf(ctx.client, "photo.view")).toEqual([]);

    // On request, the card size, each look an audit row about the report.
    for (let look = 1; look <= 2; look += 1) {
      const shown = await pointedPhoto(app, moderator.headers, id);
      expect(shown.status).toBe(200);
      const answer = PhotoUrlResponse.parse(await shown.json());
      expect(answer.variant).toBe("card");
      expect(new URL(answer.url).pathname).toBe(`/${objectKey(key, "card")}`);
      expect(answer.expiresAt).toBe(new Date(T.getTime() + 15 * 60 * 1000).toISOString());
      expect(await auditOf(ctx.client, "photo.view")).toHaveLength(look);
    }
    expect(await auditOf(ctx.client, "photo.view")).toEqual(
      Array.from({ length: 2 }, () => ({
        actor_identity_id: moderator.identityId,
        action: "photo.view",
        subject_type: "report",
        subject_id: id,
        detail: { variant: "card" },
      })),
    );
  });

  test("A pointed photo deleted since reads removed for the moderator", async ({ ctx, app }) => {
    const moderator = await staffSession(ctx.client);
    const { b, id, photoId } = await pointedCardReport(ctx);
    // The owner removes it: the report stays, its pointer goes null and says one was made.
    await ctx.client.query("DELETE FROM photo WHERE id = $1 AND account_id = $2", [
      photoId,
      b.accountId,
    ]);
    const kept = await ctx.client.query(
      "SELECT photo_id, photo_pointed FROM report WHERE id = $1",
      [id],
    );
    expect(kept.rows).toEqual([{ photo_id: null, photo_pointed: true }]);
    expect((await opened(app, moderator.headers, id)).pointedPhoto).toEqual({ removed: true });
    const before = await written(ctx.client);
    const refused = await pointedPhoto(app, moderator.headers, id);
    expect(refused.status).toBe(404);
    expect(await errorCode(refused)).toBe("not_found");
    expect(await written(ctx.client)).toEqual(before);
  });

  test("a report that points at nothing, a conversation's report and an unknown id answer 404 alike and write nothing", async ({
    ctx,
    app,
  }) => {
    const moderator = await staffSession(ctx.client);
    const { id: card } = await cardReport(ctx);
    const { id: conversation } = await reportedConversation(ctx);
    expect((await opened(app, moderator.headers, card)).pointedPhoto).toBeNull();
    expect((await opened(app, moderator.headers, conversation)).pointedPhoto).toBeNull();
    const before = await written(ctx.client);
    for (const id of [card, conversation, UNKNOWN]) {
      const refused = await pointedPhoto(app, moderator.headers, id);
      expect(refused.status).toBe(404);
      expect(await errorCode(refused)).toBe("not_found");
    }
    expect((await pointedPhoto(app, moderator.headers, "nope")).status).toBe(400);
    expect(await written(ctx.client)).toEqual(before);
  });

  test("the owner's approved photos are counted for the take-down beside it, the pointed one taken down or not", async ({
    ctx,
    app,
  }) => {
    const moderator = await staffSession(ctx.client);
    const { b, id, photoId } = await pointedCardReport(ctx);
    // A second approved photo, and a queued one that does not count.
    await ctx.client.query(
      `INSERT INTO photo (account_id, key, blurhash, width, height, state, position)
       VALUES ($1, 'k-second', 'LKO2?U%2Tw=w', 800, 1067, 'approved', 1),
              ($1, 'k-queued', 'LKO2?U%2Tw=w', 800, 1067, 'queued', 2)`,
      [b.accountId],
    );
    expect((await opened(app, moderator.headers, id)).pointedPhoto).toEqual({
      removed: false,
      id: photoId,
      state: "approved",
      approvedPhotos: 2,
    });
    await ctx.client.query("UPDATE photo SET state = 'rejected' WHERE id = $1", [photoId]);
    expect((await opened(app, moderator.headers, id)).pointedPhoto).toEqual({
      removed: false,
      id: photoId,
      state: "rejected",
      approvedPhotos: 1,
    });
  });
});

describe("POST /admin/reports/{id}/decision", () => {
  test("Dismissing closes the report with who and when, and tells nobody", async ({ ctx, app }) => {
    const moderator = await staffSession(ctx.client);
    const { a, b, id } = await cardReport(ctx);
    await ctx.client.query(
      `INSERT INTO block (blocker_identity_id, blocked_identity_id)
       SELECT ra.identity_id, rb.identity_id FROM account ra, account rb
        WHERE ra.id = $1 AND rb.id = $2`,
      [a.accountId, b.accountId],
    );
    const before = await written(ctx.client);
    const response = await decide(app, moderator.headers, id, { outcome: "dismissed" });
    expect(response.status).toBe(200);
    expect(ReportDecision.parse(await response.json())).toEqual({
      id,
      outcome: "dismissed",
      decidedAt: T.toISOString(),
      decidedBy: moderator.identityId,
      sanctionId: null,
    });
    const { rows } = await ctx.client.query(
      "SELECT outcome, decided_at, decided_by, sanction_id FROM report WHERE id = $1",
      [id],
    );
    expect(rows).toEqual([
      { outcome: "dismissed", decided_at: T, decided_by: moderator.identityId, sanction_id: null },
    ]);
    expect(await auditOf(ctx.client, "report.decide")).toEqual([
      {
        actor_identity_id: moderator.identityId,
        action: "report.decide",
        subject_type: "report",
        subject_id: id,
        detail: { outcome: "dismissed", sanctionId: null },
      },
    ]);
    const [filed] = await listReportsOfAccount(ctx.client, a.accountId, 10);
    expect(filed?.outcome).toBe("dismissed");
    expect(await count(ctx.client, "SELECT count(*) AS n FROM block")).toBe(1);
    const after = await written(ctx.client);
    expect(after).toEqual({ ...before, audit: before.audit + 1, decided: before.decided + 1 });
    // The queue moves it from the open reports to the closed ones.
    const read = async (state: string) =>
      ReportQueue.parse(
        await (
          await app.request(`/admin/reports?state=${state}`, { headers: moderator.headers })
        ).json(),
      ).items.map((item) => item.id);
    expect(await read("open")).toEqual([]);
    expect(await read("closed")).toEqual([id]);
  });

  test("Acting names the sanction the reported person was given after the report", async ({
    ctx,
    app,
  }) => {
    const moderator = await staffSession(ctx.client);
    const { a, b, id } = await cardReport(ctx);
    const warned = await warn(
      ctx.client,
      b.accountId,
      moderator.identityId,
      "2026-10-15T09:00:00.000Z",
    );
    const response = await decide(app, moderator.headers, id, {
      outcome: "acted",
      sanctionId: warned.id,
    });
    expect(response.status).toBe(200);
    expect(ReportDecision.parse(await response.json())).toMatchObject({
      outcome: "acted",
      sanctionId: warned.id,
    });
    expect((await auditOf(ctx.client, "report.decide"))[0]?.detail).toEqual({
      outcome: "acted",
      sanctionId: warned.id,
    });
    const [filed] = await listReportsOfAccount(ctx.client, a.accountId, 10);
    expect(filed?.outcome).toBe("acted");
  });

  describe("A sanction that does not answer this report is refused, and nothing is written", () => {
    test.for([
      ['"C" was warned after the report'],
      ['"B" was warned before the report was filed'],
      ['"B" was banned by nobody after the report'],
      ['"B" came back with another account and was warned there after the report'],
      ['"B" was shadow-banned by a rule after the report and a moderator reversed it'],
      ["no sanction has the id"],
    ] as const)("%s", async ([sanction], { ctx, app }) => {
      const moderator = await staffSession(ctx.client);
      const { b, id } = await cardReport(ctx);
      const [c] = await signedInPeople(ctx.client, 1);
      if (!c) throw new Error("person not written");
      const sanctionId = await {
        '"C" was warned after the report': async () =>
          (await warn(ctx.client, c.accountId, moderator.identityId, "2026-10-15T09:00:00.000Z"))
            .id,
        '"B" was warned before the report was filed': async () =>
          (await warn(ctx.client, b.accountId, moderator.identityId, "2026-10-15T07:59:59.999Z"))
            .id,
        '"B" was banned by nobody after the report': async () =>
          (await ban(ctx.client, b.accountId, null, "2026-10-15T09:00:00.000Z")).id,
        // Through another account of B's identity only a ban answers the report.
        '"B" came back with another account and was warned there after the report': async () => {
          const identity = await ctx.client.query<{ identity_id: string }>(
            "SELECT identity_id FROM account WHERE id = $1",
            [b.accountId],
          );
          await erase(ctx.client, b.accountId);
          const later = await accountOf(ctx.client, identity.rows[0]?.identity_id as string);
          return (await warn(ctx.client, later, moderator.identityId, "2026-10-15T09:00:00.000Z"))
            .id;
        },
        // An automatic ban a person reversed answers nothing (#105): only one kept does.
        '"B" was shadow-banned by a rule after the report and a moderator reversed it':
          async () => {
            const { rows } = await ctx.client.query<{ id: string }>(
              `INSERT INTO sanction (identity_id, account_id, kind, reason, note, created_at,
                                     rule, rule_count, rule_first_at, lifted_at, lifted_by,
                                     reviewed_at, reviewed_by, review_note)
               SELECT identity_id, id, 'shadow_ban', 'other', 'Applied by the automatic rule.',
                      '2026-10-15T09:00:00Z', 'reports', 3, '2026-10-15T08:00:00Z',
                      '2026-10-15T10:00:00Z', $2, '2026-10-15T10:00:00Z', $2, 'Not abuse.'
                 FROM account WHERE id = $1 RETURNING id`,
              [b.accountId, moderator.identityId],
            );
            return rows[0]?.id as string;
          },
        "no sanction has the id": async () => randomUUID(),
      }[sanction]();
      const before = await written(ctx.client);
      const response = await decide(app, moderator.headers, id, { outcome: "acted", sanctionId });
      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe("sanction_not_for_report");
      expect(await written(ctx.client)).toEqual(before);
      expect(await auditOf(ctx.client, "report.decide")).toEqual([]);
      // Nor is it offered to close the report with.
      const report = await opened(app, moderator.headers, id);
      expect(report.outcome).toBeNull();
      expect(report.actable.map((s) => s.id)).not.toContain(sanctionId);
    });
  });

  test("a sanction given at the moment of the filing answers it, and so do a lifted and a reviewed one; one on the reporter does not", async ({
    ctx,
    app,
  }) => {
    const moderator = await staffSession(ctx.client);
    const admin = await staffSession(ctx.client, "admin");
    // One after another: the test's one connection takes one statement at a time.
    const atFiling = await cardReport(ctx);
    const liftedOne = await cardReport(ctx);
    const reviewedOne = await cardReport(ctx);
    const exact = await warn(ctx.client, atFiling.b.accountId, moderator.identityId, FILED);
    const lifted = await warn(
      ctx.client,
      liftedOne.b.accountId,
      moderator.identityId,
      "2026-10-15T09:00:00.000Z",
    );
    await ctx.client.query(
      "UPDATE sanction SET lifted_at = '2026-10-15T10:00:00Z', lifted_by = $2 WHERE id = $1",
      [lifted.id, admin.identityId],
    );
    const reviewed = await warn(
      ctx.client,
      reviewedOne.b.accountId,
      moderator.identityId,
      "2026-10-15T09:00:00.000Z",
    );
    await ctx.client.query(
      `UPDATE sanction SET reviewed_at = '2026-10-15T10:00:00Z', reviewed_by = $2,
              review_note = 'Looked again; it stands.' WHERE id = $1`,
      [reviewed.id, admin.identityId],
    );
    const onReporter = await warn(
      ctx.client,
      reviewedOne.a.accountId,
      moderator.identityId,
      "2026-10-15T09:00:00.000Z",
    );
    const refused = await decide(app, moderator.headers, reviewedOne.id, {
      outcome: "acted",
      sanctionId: onReporter.id,
    });
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("sanction_not_for_report");
    for (const [report, sanction] of [
      [atFiling, exact],
      [liftedOne, lifted],
      [reviewedOne, reviewed],
    ] as const) {
      const response = await decide(app, moderator.headers, report.id, {
        outcome: "acted",
        sanctionId: sanction.id,
      });
      expect(response.status).toBe(200);
    }
  });

  test("A ban of the reported person's identity through a later account answers the report", async ({
    ctx,
    app,
  }) => {
    const moderator = await staffSession(ctx.client);
    const admin = await staffSession(ctx.client, "admin");
    const { b, id } = await cardReport(ctx);
    const identity = await ctx.client.query<{ identity_id: string }>(
      "SELECT identity_id FROM account WHERE id = $1",
      [b.accountId],
    );
    await erase(ctx.client, b.accountId);
    const later = await accountOf(ctx.client, identity.rows[0]?.identity_id as string);
    const banned = await ban(ctx.client, later, admin.identityId, "2026-10-15T09:00:00.000Z");
    const response = await decide(app, moderator.headers, id, {
      outcome: "acted",
      sanctionId: banned.id,
    });
    expect(response.status).toBe(200);
    expect(ReportDecision.parse(await response.json())).toMatchObject({
      outcome: "acted",
      sanctionId: banned.id,
    });
  });

  test("One sanction closes every report it was given for", async ({ ctx, app }) => {
    const moderator = await staffSession(ctx.client);
    const admin = await staffSession(ctx.client, "admin");
    const [a, b, c] = await signedInPeople(ctx.client, 3);
    if (!a || !b || !c) throw new Error("people not written");
    const first = await reportIn(ctx.client, a.accountId, b.accountId, FILED);
    const second = await reportIn(ctx.client, c.accountId, b.accountId, "2026-10-15T08:30:00.000Z");
    const banned = await ban(ctx.client, b.accountId, admin.identityId, "2026-10-15T09:00:00.000Z");
    for (const id of [first, second]) {
      const response = await decide(app, moderator.headers, id, {
        outcome: "acted",
        sanctionId: banned.id,
      });
      expect(response.status).toBe(200);
    }
    const { rows } = await ctx.client.query(
      "SELECT outcome, sanction_id FROM report ORDER BY created_at",
    );
    expect(rows).toEqual([
      { outcome: "acted", sanction_id: banned.id },
      { outcome: "acted", sanction_id: banned.id },
    ]);
  });

  test("Acting without a sanction is refused, and so is dismissing with one", async ({
    ctx,
    app,
  }) => {
    const moderator = await staffSession(ctx.client);
    const { id } = await cardReport(ctx);
    const before = await written(ctx.client);
    for (const body of [{ outcome: "acted" }, { outcome: "dismissed", sanctionId: randomUUID() }]) {
      const response = await decide(app, moderator.headers, id, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await errorCode(response)).toBe("validation_failed");
    }
    expect(await written(ctx.client)).toEqual(before);
  });

  test.for([
    ["an unknown outcome", { outcome: "ignored" }],
    ["an extra key", { outcome: "dismissed", note: "x" }],
    ["an empty body", {}],
    ["a sanction id that is no uuid", { outcome: "acted", sanctionId: "warn-1" }],
  ] as const)("%s is refused with 400", async ([, body], { ctx, app }) => {
    const moderator = await staffSession(ctx.client);
    const { id } = await cardReport(ctx);
    const response = await decide(app, moderator.headers, id, body);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("validation_failed");
  });

  test("a second decision is refused with report_decided, and an unknown report is 404", async ({
    ctx,
    app,
  }) => {
    const moderator = await staffSession(ctx.client);
    const { id } = await cardReport(ctx);
    expect((await decide(app, moderator.headers, id, { outcome: "dismissed" })).status).toBe(200);
    const before = await written(ctx.client);
    const again = await decide(app, moderator.headers, id, { outcome: "dismissed" });
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("report_decided");
    const unknown = await decide(app, moderator.headers, UNKNOWN, { outcome: "dismissed" });
    expect(unknown.status).toBe(404);
    expect(await errorCode(unknown)).toBe("not_found");
    expect(await written(ctx.client)).toEqual(before);
    expect((await auditOf(ctx.client, "report.decide")).length).toBe(1);
  });

  test("once decided, the reporter may report the same person again", async ({ ctx, app }) => {
    const moderator = await staffSession(ctx.client);
    const { a, b, id } = await cardReport(ctx);
    expect((await decide(app, moderator.headers, id, { outcome: "dismissed" })).status).toBe(200);
    // The one open report per pair (#84) counts the waiting ones only.
    const again = await reportIn(ctx.client, a.accountId, b.accountId, "2026-10-15T09:00:00.000Z");
    expect(again).not.toBe(id);
  });

  test("A report is decided once, also when two moderators decide it at the same moment", async () => {
    await withTwoConnections("kuutti-312-decide", async (pool, first, second) => {
      const one = await staffSession(pool);
      const two = await staffSession(pool);
      const [a, b] = await signedInPeople(pool, 2);
      if (!a || !b) throw new Error("people not written");
      const id = await reportIn(pool, a.accountId, b.accountId, FILED);
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      // The first decision is written and holds the report's row, uncommitted.
      await decideReport(first, {
        staffIdentityId: one.identityId,
        id,
        decision: { outcome: "dismissed" },
        at: T,
      });
      // The second finds it waiting, writes its audit row, and waits on the row.
      const racing = watched(
        decideReport(second, {
          staffIdentityId: two.identityId,
          id,
          decision: { outcome: "dismissed" },
          at: T,
        }),
      );
      expect(await waitsFor(pool, secondPid, firstPid, racing.settled)).toBe(true);
      await first.query("COMMIT");
      expect(await racing.outcome).toBe("report_decided");
      await second.query("ROLLBACK");
      // Afterwards, the same refusal through its own transaction.
      await expect(
        transaction(pool, (tx) =>
          decideReport(tx, {
            staffIdentityId: two.identityId,
            id,
            decision: { outcome: "dismissed" },
            at: T,
          }),
        ),
      ).rejects.toMatchObject({ code: "report_decided" });
      expect(
        await count(pool, "SELECT count(*) AS n FROM audit_log WHERE action = 'report.decide'"),
      ).toBe(1);
      const { rows } = await pool.query("SELECT decided_by FROM report WHERE id = $1", [id]);
      expect(rows).toEqual([{ decided_by: one.identityId }]);
    });
  });
});

describe("recusal and the guard", () => {
  test("A member of staff who is a party to a report gets the answer of a report that does not exist", async ({
    ctx,
  }) => {
    const media = testMediaDeps();
    const app = await appOn(ctx.client, media.deps);
    const m = await staffSession(ctx.client);
    const other = await staffSession(ctx.client);
    const [x, y] = await signedInPeople(ctx.client, 2);
    if (!x || !y) throw new Error("people not written");
    // M once used the app with an account since erased, and uses it now.
    const earlier = await accountOf(ctx.client, m.identityId, "deleted");
    const now = await accountOf(ctx.client, m.identityId);
    const byM = await reportIn(ctx.client, earlier, x.accountId, FILED);
    // M's report points at a photo of X's card (#476): still not M's to look at.
    const pointed = await ctx.client.query<{ id: string }>(
      `INSERT INTO photo (account_id, key, blurhash, width, height, state, position)
       VALUES ($1, 'k-pointed', 'LKO2?U%2Tw=w', 800, 1067, 'approved', 0) RETURNING id`,
      [x.accountId],
    );
    await ctx.client.query("UPDATE report SET photo_id = $2, photo_pointed = true WHERE id = $1", [
      byM,
      pointed.rows[0]?.id,
    ]);
    const conversationId = await conversationBetween(ctx.client, y.accountId, now, {
      openedAt: OPENED_AT,
      messages: [{ from: "b", body: "Moi" }],
    });
    const sent = await photoMessage(ctx.client, {
      conversationId,
      accountId: now,
      side: "b",
      store: media.store,
    });
    const aboutM = await fileFrom(ctx, y, conversationId);

    // Every answer but its request id, which each request has of its own.
    const body = async (response: Response) => {
      const { error } = ErrorResponse.parse(await response.json());
      return { ...error, requestId: undefined };
    };
    const unknown = [
      await body(await open(app, m.headers, UNKNOWN)),
      await body(await photo(app, m.headers, UNKNOWN, sent.seq)),
      await body(await pointedPhoto(app, m.headers, UNKNOWN)),
      await body(await decide(app, m.headers, UNKNOWN, { outcome: "dismissed" })),
    ];
    const before = await written(ctx.client);
    for (const id of [byM, aboutM]) {
      const answers = [
        await open(app, m.headers, id),
        await photo(app, m.headers, id, sent.seq),
        await pointedPhoto(app, m.headers, id),
        await decide(app, m.headers, id, { outcome: "dismissed" }),
      ];
      expect(answers.map((answer) => answer.status)).toEqual([404, 404, 404, 404]);
      expect(await Promise.all(answers.map(body))).toEqual(unknown);
    }
    expect(await written(ctx.client)).toEqual(before);

    // Another moderator opens both, sees the photos, and decides both.
    for (const id of [byM, aboutM]) {
      expect((await open(app, other.headers, id)).status).toBe(200);
    }
    expect((await photo(app, other.headers, aboutM, sent.seq)).status).toBe(200);
    expect((await pointedPhoto(app, other.headers, byM)).status).toBe(200);
    for (const id of [byM, aboutM]) {
      expect((await decide(app, other.headers, id, { outcome: "dismissed" })).status).toBe(200);
    }
  });

  test("The report's routes refuse without a session, and refuse a researcher", async ({
    ctx,
    app,
  }) => {
    const member = await signedInAccount(ctx.client);
    const researcher = await staffSession(ctx.client, "researcher");
    const expired = await staffSession(ctx.client);
    await ctx.client.query(
      "UPDATE admin_session SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [expired.sessionId],
    );
    const revoked = await staffSession(ctx.client);
    await ctx.client.query("UPDATE admin_session SET revoked_at = now() WHERE id = $1", [
      revoked.sessionId,
    ]);
    const { id } = await cardReport(ctx);
    const before = await written(ctx.client);
    for (const [what, headers, status, code] of [
      ["no token", {}, 401, "unauthenticated"],
      ["a product session's token", member.headers, 401, "unauthenticated"],
      ["an expired session", expired.headers, 401, "session_expired"],
      ["a revoked session", revoked.headers, 401, "session_revoked"],
      ["a researcher", researcher.headers, 403, "admin_forbidden"],
    ] as const) {
      for (const answer of [
        await open(app, headers, id),
        await photo(app, headers, id, 1),
        await pointedPhoto(app, headers, id),
        await decide(app, headers, id, { outcome: "dismissed" }),
      ]) {
        expect(answer.status, what).toBe(status);
        expect(await errorCode(answer), what).toBe(code);
      }
    }
    expect(await written(ctx.client)).toEqual(before);
  });
});
