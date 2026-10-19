import { AUDIT_PAGE_SIZE, AuditPage, ErrorResponse } from "@kuutti/schema";
import type { App } from "../app.ts";
import { type Staff, signedInAccount, staffSession } from "../test/account.ts";
import { describe, expect, type TestContext, test } from "../test/harness.ts";

// The audit log's reader through the app (#309): each filter alone and
// together on rows written straight into the test's transaction, newest
// first, fifty a page, the keyset cursor's stability while rows arrive
// between pages and its refusal of a cursor the route did not give, every
// validation rule, the admins' guard, and no audit row for the read.
// audit_log is append-only, but the rollback after each test takes its rows
// back with everything else.

type Headers = Record<string, string>;
type Query = Record<string, string>;

/** Subjects; audit_log.subject_id references nothing, so any id is a subject. */
const PHOTO_1 = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const PHOTO_2 = "0b7d3a52-6c1e-4f0a-8d2b-5e9f1a3c7d40";
const ACCOUNT_1 = "3c9e2f71-1a4b-4d6e-9f08-7b2a5c8d1e36";
const ACCOUNT_2 = "a41d6b0c-2e3f-4a57-8b91-c0d2e4f6a8b1";
const ID = "00000000-0000-4000-8000-000000000309";
const NEWEST = "2026-10-16T09:00:00.000Z";

async function audit(app: App, headers: Headers, query: Query = {}): Promise<Response> {
  const search = new URLSearchParams(query).toString();
  return app.request(search ? `/admin/audit?${search}` : "/admin/audit", { headers });
}

async function page(app: App, headers: Headers, query: Query = {}): Promise<AuditPage> {
  const response = await audit(app, headers, query);
  expect(response.status, JSON.stringify(query)).toBe(200);
  return AuditPage.parse(await response.json());
}

/** Every page from the first, following `next` to its end (at most ten, so a loop cannot hang the run). */
async function pages(app: App, headers: Headers, query: Query = {}): Promise<AuditPage[]> {
  const out: AuditPage[] = [];
  let before: string | null = null;
  do {
    const answer: AuditPage = await page(app, headers, before ? { ...query, before } : query);
    out.push(answer);
    before = answer.next;
  } while (before !== null && out.length < 10);
  return out;
}

/** The rows' labels: every seeded row carries `{ n }` as its detail. */
const labels = (p: AuditPage) => p.items.map((item) => item.detail?.n);

async function errorCode(response: Response): Promise<string> {
  return ErrorResponse.parse(await response.json()).error.code;
}

async function auditRows(ctx: TestContext) {
  return (await ctx.client.query("SELECT * FROM audit_log ORDER BY at, id")).rows;
}

const base64url = (text: string) => Buffer.from(text).toString("base64url");
const cursor = (value: unknown) => base64url(JSON.stringify(value));

type Seed = {
  n: number;
  at: string;
  actor: string;
  action: string;
  subjectType: string;
  subjectId: string;
};

async function auditIn(ctx: TestContext, row: Seed): Promise<void> {
  await ctx.client.query(
    `INSERT INTO audit_log (at, actor_identity_id, action, subject_type, subject_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.at, row.actor, row.action, row.subjectType, row.subjectId, JSON.stringify({ n: row.n })],
  );
}

/**
 * `count` photo.view rows by `actor`, `step` apart going back from `newest`:
 * n = 1 is the newest. A step of zero puts every row on the same instant.
 */
async function rowsIn(
  ctx: TestContext,
  actor: string,
  count: number,
  options: { newest?: string; step?: string; first?: number } = {},
): Promise<void> {
  await ctx.client.query(
    `INSERT INTO audit_log (at, actor_identity_id, action, subject_type, subject_id, detail)
     SELECT $1::timestamptz - (n - $5::int) * $4::interval, $2, 'photo.view', 'photo', $3,
            jsonb_build_object('n', n)
     FROM generate_series($5::int, $5::int + $6::int - 1) AS n`,
    [
      options.newest ?? NEWEST,
      actor,
      PHOTO_1,
      options.step ?? "1 minute",
      options.first ?? 1,
      count,
    ],
  );
}

/** The labels of an actor's rows in the order the log is read: newest first, then the larger id. */
async function readOrder(ctx: TestContext, actor: string): Promise<number[]> {
  const { rows } = await ctx.client.query<{ n: number }>(
    `SELECT (detail->>'n')::int AS n FROM audit_log WHERE actor_identity_id = $1
     ORDER BY at DESC, id DESC`,
    [actor],
  );
  return rows.map((r) => r.n);
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

type Cast = { a: Staff; b: Staff; admin: Staff };

async function cast(ctx: TestContext): Promise<Cast> {
  return {
    a: await staffSession(ctx.client, "moderator"),
    b: await staffSession(ctx.client, "moderator"),
    admin: await staffSession(ctx.client, "admin"),
  };
}

/**
 * Seven rows across two actors, four actions, two subject types and four
 * subjects, a different time each; written out of order, so the answer's
 * order cannot be the order they went in.
 */
function fixture({ a, b }: Cast): Seed[] {
  return [
    {
      n: 4,
      at: "2026-10-13T12:00:00.000Z",
      actor: b.identityId,
      action: "account.view",
      subjectType: "account",
      subjectId: ACCOUNT_1,
    },
    {
      n: 1,
      at: "2026-10-15T12:00:00.000Z",
      actor: a.identityId,
      action: "photo.view",
      subjectType: "photo",
      subjectId: PHOTO_1,
    },
    {
      n: 7,
      at: "2026-10-10T12:00:00.000Z",
      actor: a.identityId,
      action: "account.view",
      subjectType: "account",
      subjectId: ACCOUNT_2,
    },
    {
      n: 2,
      at: "2026-10-15T08:00:00.000Z",
      actor: b.identityId,
      action: "photo.view",
      subjectType: "photo",
      subjectId: PHOTO_2,
    },
    {
      n: 6,
      at: "2026-10-11T12:00:00.000Z",
      actor: b.identityId,
      action: "photo.view",
      subjectType: "photo",
      subjectId: PHOTO_1,
    },
    {
      n: 3,
      at: "2026-10-14T12:00:00.000Z",
      actor: a.identityId,
      action: "photo.reject",
      subjectType: "photo",
      subjectId: PHOTO_1,
    },
    {
      n: 5,
      at: "2026-10-12T12:00:00.000Z",
      actor: a.identityId,
      action: "sanction.apply",
      subjectType: "account",
      subjectId: ACCOUNT_1,
    },
  ];
}

async function seeded(ctx: TestContext): Promise<Cast> {
  const people = await cast(ctx);
  for (const row of fixture(people)) await auditIn(ctx, row);
  return people;
}

describe("GET /admin/audit", () => {
  test("answers every field of each row, newest first, and no next when one page holds them", async ({
    ctx,
  }) => {
    const people = await seeded(ctx);
    // One row with a richer detail and one with none at all.
    await ctx.client.query(
      `INSERT INTO audit_log (at, actor_identity_id, action, subject_type, subject_id, detail)
       VALUES ('2026-10-15T23:59:59.999Z', $1, 'sanction.lift', 'account', $2,
               '{"kind": "suspend", "days": 7, "appealed": false, "note": null}'),
              ('2026-10-09T00:00:00.001Z', $1, 'feedback.handle', 'feedback', $3, NULL)`,
      [people.b.identityId, ACCOUNT_1, ID],
    );
    const answer = await page(ctx.app, people.admin.headers);
    expect(answer.next).toBeNull();
    expect(answer.items).toEqual([
      {
        at: "2026-10-15T23:59:59.999Z",
        actorIdentityId: people.b.identityId,
        actorRole: "moderator",
        action: "sanction.lift",
        subjectType: "account",
        subjectId: ACCOUNT_1,
        accountId: ACCOUNT_1,
        detail: { kind: "suspend", days: 7, appealed: false, note: null },
      },
      ...[...fixture(people)]
        .sort((x, y) => y.at.localeCompare(x.at))
        .map((row) => ({
          at: row.at,
          actorIdentityId: row.actor,
          actorRole: "moderator",
          action: row.action,
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          // The fixture's photos are ids only, no rows: nobody's page to name.
          accountId: row.subjectType === "account" ? row.subjectId : null,
          detail: { n: row.n },
        })),
      {
        at: "2026-10-09T00:00:00.001Z",
        actorIdentityId: people.b.identityId,
        actorRole: "moderator",
        action: "feedback.handle",
        subjectType: "feedback",
        subjectId: ID,
        accountId: null,
        detail: null,
      },
    ]);
  });

  test("a row about a report names no person, even where its id is an account's (#312, ADR-030 §6)", async ({
    ctx,
  }) => {
    const { a, admin } = await cast(ctx);
    await auditIn(ctx, {
      n: 1,
      at: "2026-10-09T00:00:00.000Z",
      actor: a.identityId,
      action: "report.decide",
      subjectType: "report",
      subjectId: ACCOUNT_1,
    });
    const answer = await page(ctx.app, admin.headers, { subjectType: "report" });
    expect(
      answer.items
        .filter((item) => item.action === "report.decide")
        .map((item) => [item.subjectType, item.subjectId, item.accountId]),
    ).toEqual([["report", ACCOUNT_1, null]]);
  });

  test("names the actor's role now and the person behind a photo; neither once the role or the photo is gone", async ({
    ctx,
  }) => {
    const admin = await staffSession(ctx.client, "admin");
    const moderator = await staffSession(ctx.client, "moderator");
    const former = await staffSession(ctx.client, "moderator");
    const person = await signedInAccount(ctx.client);
    const { rows } = await ctx.client.query<{ id: string }>(
      `INSERT INTO photo (account_id, key, blurhash, width, height, position)
       VALUES ($1, 'k309', 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 10, 10, 0) RETURNING id`,
      [person.accountId],
    );
    const photo = rows[0]?.id ?? "";
    const row = (at: string, actor: string, action: string, type: string, subject: string) =>
      ctx.client.query(
        `INSERT INTO audit_log (at, actor_identity_id, action, subject_type, subject_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [at, actor, action, type, subject],
      );
    await row("2026-10-16T08:00:00.000Z", moderator.identityId, "photo.view", "photo", photo);
    await row(
      "2026-10-16T07:00:00.000Z",
      admin.identityId,
      "account.view",
      "account",
      person.accountId,
    );
    await row("2026-10-16T06:00:00.000Z", former.identityId, "photo.view", "photo", PHOTO_1);
    await ctx.client.query("DELETE FROM moderator_roles WHERE identity_id = $1", [
      former.identityId,
    ]);

    const answer = await page(ctx.app, admin.headers);
    expect(
      answer.items.map(({ actorRole, subjectType, accountId }) => ({
        actorRole,
        subjectType,
        accountId,
      })),
    ).toEqual([
      { actorRole: "moderator", subjectType: "photo", accountId: person.accountId },
      { actorRole: "admin", subjectType: "account", accountId: person.accountId },
      { actorRole: null, subjectType: "photo", accountId: null },
    ]);
  });

  test("an empty log answers an empty page and no next", async ({ ctx }) => {
    const admin = await staffSession(ctx.client, "admin");
    expect(await page(ctx.app, admin.headers)).toEqual({ items: [], next: null });
  });

  // Each filter alone, then together; the ids of the cast are put in at run time.
  test.for([
    ["no filter", () => ({}), [1, 2, 3, 4, 5, 6, 7]],
    ["actor", (c: Cast) => ({ actor: c.a.identityId }), [1, 3, 5, 7]],
    ["the other actor", (c: Cast) => ({ actor: c.b.identityId }), [2, 4, 6]],
    ["an actor who did nothing", (c: Cast) => ({ actor: c.admin.identityId }), []],
    ["action", () => ({ action: "photo.view" }), [1, 2, 6]],
    ["an action no row has", () => ({ action: "feedback.handle" }), []],
    ["subjectType", () => ({ subjectType: "account" }), [4, 5, 7]],
    ["subjectId", () => ({ subjectId: PHOTO_1 }), [1, 3, 6]],
    [
      "from, which holds the row at its own instant",
      () => ({ from: "2026-10-13T12:00:00.000Z" }),
      [1, 2, 3, 4],
    ],
    [
      "to, which leaves out the row at its own instant",
      () => ({ to: "2026-10-13T12:00:00.000Z" }),
      [5, 6, 7],
    ],
    ["actor and action", (c: Cast) => ({ actor: c.a.identityId, action: "account.view" }), [7]],
    [
      "actor and subjectType",
      (c: Cast) => ({ actor: c.b.identityId, subjectType: "photo" }),
      [2, 6],
    ],
    [
      "subjectType, subjectId and a window",
      () => ({
        subjectType: "account",
        subjectId: ACCOUNT_1,
        from: "2026-10-12T12:00:00.000Z",
        to: "2026-10-13T12:00:00.001Z",
      }),
      [4, 5],
    ],
    [
      "all six",
      (c: Cast) => ({
        actor: c.a.identityId,
        action: "photo.reject",
        subjectType: "photo",
        subjectId: PHOTO_1,
        from: "2026-10-14T12:00:00.000Z",
        to: "2026-10-14T12:00:00.001Z",
      }),
      [3],
    ],
    [
      "all six, one of them off",
      (c: Cast) => ({
        actor: c.b.identityId,
        action: "photo.reject",
        subjectType: "photo",
        subjectId: PHOTO_1,
        from: "2026-10-14T12:00:00.000Z",
        to: "2026-10-14T12:00:00.001Z",
      }),
      [],
    ],
    [
      "a subject type and an id that never meet",
      () => ({ subjectType: "photo", subjectId: ACCOUNT_1 }),
      [],
    ],
    [
      "a window that ends before it begins",
      () => ({ from: "2026-10-14T00:00:00.000Z", to: "2026-10-12T00:00:00.000Z" }),
      [],
    ],
    [
      "a window of zero length",
      () => ({ from: "2026-10-13T12:00:00.000Z", to: "2026-10-13T12:00:00.000Z" }),
      [],
    ],
  ] as const)("filters by %s", async ([, query, expected], { ctx }) => {
    const people = await seeded(ctx);
    const answer = await page(ctx.app, people.admin.headers, query(people));
    // A read narrowed to a subject writes audit.read about it first, and may see it: the seeded rows are the rest.
    const seededRows = answer.items.filter((item) => item.action !== "audit.read");
    expect(labels({ ...answer, items: seededRows })).toEqual(expected);
    expect(answer.next).toBeNull();
  });

  test("from is inclusive and to exclusive, to the millisecond", async ({ ctx }) => {
    const { a, admin } = await cast(ctx);
    const at = "2026-10-16T09:00:00.000Z";
    for (const [n, when] of [
      [1, "2026-10-16T09:00:00.001Z"],
      [2, at],
      [3, "2026-10-16T08:59:59.999Z"],
    ] as const) {
      await auditIn(ctx, {
        n,
        at: when,
        actor: a.identityId,
        action: "photo.view",
        subjectType: "photo",
        subjectId: PHOTO_1,
      });
    }
    const read = async (query: Query) => labels(await page(ctx.app, admin.headers, query));
    expect(await read({ from: at })).toEqual([1, 2]);
    expect(await read({ to: at })).toEqual([3]);
    expect(await read({ from: at, to: "2026-10-16T09:00:00.001Z" })).toEqual([2]);
    expect(
      await read({ from: "2026-10-16T08:59:59.999Z", to: "2026-10-16T09:00:00.002Z" }),
    ).toEqual([1, 2, 3]);
    // Sub-millisecond digits are the client's to send, and mean what they say.
    expect(await read({ from: "2026-10-16T08:59:59.9995Z" })).toEqual([1, 2]);
  });

  // The page's size against the rows it may hold: none, one, one short of a
  // page, a page, one past, two pages, and two and a bit; filtered by actor,
  // so the cursor is shown to keep the filter.
  test.for([
    [0, [0]],
    [1, [1]],
    [AUDIT_PAGE_SIZE - 1, [AUDIT_PAGE_SIZE - 1]],
    [AUDIT_PAGE_SIZE, [AUDIT_PAGE_SIZE]],
    [AUDIT_PAGE_SIZE + 1, [AUDIT_PAGE_SIZE, 1]],
    [2 * AUDIT_PAGE_SIZE, [AUDIT_PAGE_SIZE, AUDIT_PAGE_SIZE]],
    [2 * AUDIT_PAGE_SIZE + 20, [AUDIT_PAGE_SIZE, AUDIT_PAGE_SIZE, 20]],
  ] as const)(
    "%i rows answer pages of %j, a next on each but the last",
    async ([count, sizes], { ctx }) => {
      const { a, b, admin } = await cast(ctx);
      await rowsIn(ctx, a.identityId, count);
      // Another actor's rows in between, which the filter keeps out of every page.
      await rowsIn(ctx, b.identityId, 30, { newest: "2026-10-16T08:30:30.000Z", first: 1000 });
      const read = await pages(ctx.app, admin.headers, { actor: a.identityId });
      expect(read.map((p) => p.items.length)).toEqual(sizes);
      expect(read.map((p) => p.next === null)).toEqual(sizes.map((_, i) => i === sizes.length - 1));
      expect(read.flatMap(labels)).toEqual(range(1, count));
    },
  );

  test("a page is fifty rows without any filter too, and a parameter it does not know cannot widen it", async ({
    ctx,
  }) => {
    const { a, b, admin } = await cast(ctx);
    await rowsIn(ctx, a.identityId, 60);
    await rowsIn(ctx, b.identityId, 60, { newest: "2026-10-16T08:59:30.000Z", first: 61 });
    const queries: Query[] = [{}, { limit: "1000" }, { pageSize: "500" }, { all: "true" }];
    for (const query of queries) {
      const first = await page(ctx.app, admin.headers, query);
      expect(first.items, JSON.stringify(query)).toHaveLength(AUDIT_PAGE_SIZE);
      expect(first.next, JSON.stringify(query)).not.toBeNull();
    }
    const read = await pages(ctx.app, admin.headers);
    expect(read.map((p) => p.items.length)).toEqual([50, 50, 20]);
    // Interleaved half a minute apart: a's n and b's n + 60 alternate.
    expect(read.flatMap(labels)).toEqual(range(1, 60).flatMap((n) => [n, n + 60]));
  });

  test("paging is stable while rows are written between pages: the cursor is a place, not an offset", async ({
    ctx,
  }) => {
    const { a, admin } = await cast(ctx);
    await rowsIn(ctx, a.identityId, 60);
    const first = await page(ctx.app, admin.headers);
    expect(labels(first)).toEqual(range(1, 50));
    const next = first.next;
    expect(next).not.toBeNull();
    // Three looks are recorded while the admin reads the first page.
    await rowsIn(ctx, a.identityId, 3, { newest: "2026-10-16T09:03:00.000Z", first: 101 });
    const second = await page(ctx.app, admin.headers, { before: next ?? "" });
    expect(labels(second)).toEqual(range(51, 60));
    expect(second.next).toBeNull();
    // Read again from the top, the new rows come first.
    expect(labels(await page(ctx.app, admin.headers)).slice(0, 5)).toEqual([101, 102, 103, 1, 2]);
  });

  test("the same cursor answers the same page twice", async ({ ctx }) => {
    const { a, admin } = await cast(ctx);
    await rowsIn(ctx, a.identityId, 70);
    const { next } = await page(ctx.app, admin.headers);
    const once = await page(ctx.app, admin.headers, { before: next ?? "" });
    const twice = await page(ctx.app, admin.headers, { before: next ?? "" });
    expect(twice).toEqual(once);
    expect(labels(once)).toEqual(range(51, 70));
  });

  test("rows on one millisecond are ordered by id and split across pages without a loss or a repeat", async ({
    ctx,
  }) => {
    const { a, admin } = await cast(ctx);
    await rowsIn(ctx, a.identityId, AUDIT_PAGE_SIZE + 5, { step: "0" });
    const read = await pages(ctx.app, admin.headers);
    expect(read.map((p) => p.items.length)).toEqual([AUDIT_PAGE_SIZE, 5]);
    expect(read.flatMap(labels)).toEqual(await readOrder(ctx, a.identityId));
  });

  // The column's default is the transaction's now(), to the microsecond: rows
  // written by one action, or by two within a millisecond, share their
  // millisecond, and the cursor must still find the rest of them.
  test.for([
    ["one microsecond instant", { newest: "2026-10-16T09:00:00.123456Z", step: "0" }],
    [
      "microseconds apart within one millisecond",
      { newest: "2026-10-16T09:00:00.123900Z", step: "1 microsecond" },
    ],
  ] as const)("rows on %s are split across pages without a loss", async ([, options], { ctx }) => {
    const { a, admin } = await cast(ctx);
    await rowsIn(ctx, a.identityId, AUDIT_PAGE_SIZE + 5, options);
    const read = await pages(ctx.app, admin.headers);
    expect(read.map((p) => p.items.length)).toEqual([AUDIT_PAGE_SIZE, 5]);
    expect(read.flatMap(labels)).toEqual(await readOrder(ctx, a.identityId));
  });

  test("a well-formed cursor of a row that is not there pages from its place", async ({ ctx }) => {
    const { a, admin } = await cast(ctx);
    await rowsIn(ctx, a.identityId, 10);
    // n = 4 is at 08:57; a cursor just after it answers 4 onwards.
    const answer = await page(ctx.app, admin.headers, {
      before: cursor(["2026-10-16T08:57:00.001Z", ID]),
    });
    expect(labels(answer)).toEqual(range(4, 10));
    expect(answer.next).toBeNull();
  });

  // What the route did not give: refused before the database is asked, never a 500.
  test.for([
    ["not base64 at all", "!!!"],
    ["base64 of something not JSON", base64url("not json")],
    ["an object, not a pair", cursor({ at: NEWEST, id: ID })],
    ["null", cursor(null)],
    ["a string", cursor("ab")],
    ["a pair of numbers", cursor([1, 2])],
    ["a time alone", cursor([NEWEST])],
    ["the pair the wrong way round", cursor([ID, NEWEST])],
    ["not a date", cursor(["yesterday", ID])],
    ["an id that is not a uuid", cursor([NEWEST, "not-a-uuid"])],
    ["an id of 36 characters other than hex and dashes", cursor([NEWEST, "z".repeat(36)])],
  ] as const)(
    "a cursor that is %s is refused with 400 cursor_invalid",
    async ([, before], { ctx }) => {
      const { a, admin } = await cast(ctx);
      await rowsIn(ctx, a.identityId, 3);
      const response = await audit(ctx.app, admin.headers, { before });
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("cursor_invalid");
    },
  );

  // The same promise for values JavaScript's Date.parse or the id's pattern
  // let through but Postgres refuses: these reach the query today.
  test.for([
    ["a date Date.parse reads and Postgres does not", cursor(["1", ID])],
    ["a year alone", cursor(["2026", ID])],
    ["the 30th of February", cursor(["2026-02-30T00:00:00.000Z", ID])],
    [
      "an id of 36 hex digits and no dashes",
      cursor([NEWEST, "0123456789abcdef0123456789abcdef0123"]),
    ],
    ["an id of 36 dashes", cursor([NEWEST, "-".repeat(36)])],
  ] as const)(
    "a cursor with %s is refused with 400 cursor_invalid",
    async ([, before], { ctx }) => {
      const { a, admin } = await cast(ctx);
      await rowsIn(ctx, a.identityId, 3);
      const response = await audit(ctx.app, admin.headers, { before });
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("cursor_invalid");
    },
  );

  test.for([
    ["actor", "not-a-uuid"],
    ["actor", ""],
    ["subjectId", "not-a-uuid"],
    ["subjectId", `${PHOTO_1}0`],
    ["action", "photo"],
    ["action", "photo.view.card"],
    ["action", "Photo.view"],
    ["action", "photo.v1ew"],
    ["action", "photo_view"],
    ["action", ".view"],
    ["action", `${"a".repeat(30)}.${"b".repeat(30)}`],
    ["subjectType", "Photo"],
    ["subjectType", "photo2"],
    ["subjectType", "photo.view"],
    ["subjectType", ""],
    ["subjectType", "a".repeat(41)],
    ["from", "2026-10-16"],
    ["from", "yesterday"],
    ["from", "2026-10-16 09:00:00Z"],
    ["from", "2026-13-01T00:00:00Z"],
    ["to", "2026-10-16"],
    ["to", "16.10.2026 12:00"],
    ["to", "2026-10-16T09:00:00"],
    ["from", `2026-10-16T10:00:00.${"1".repeat(130)}Z`],
    ["to", `2026-10-16T10:00:00.${"1".repeat(130)}Z`],
    ["before", "A".repeat(201)],
  ] as const)("refuses %s=%j with 400 validation_failed", async ([name, value], { ctx }) => {
    const { a, admin } = await cast(ctx);
    await rowsIn(ctx, a.identityId, 3);
    const response = await audit(ctx.app, admin.headers, { [name]: value });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("validation_failed");
  });

  test.for([
    ["action", `${"a".repeat(30)}.${"b".repeat(29)}`],
    ["subjectType", "a".repeat(40)],
  ] as const)("takes %s at its longest", async ([name, value], { ctx }) => {
    const admin = await staffSession(ctx.client, "admin");
    expect(await page(ctx.app, admin.headers, { [name]: value })).toEqual({
      items: [],
      next: null,
    });
  });

  test("a read not narrowed to a subject writes no audit row, whatever it answered", async ({
    ctx,
  }) => {
    const { a, admin } = await cast(ctx);
    await rowsIn(ctx, a.identityId, 70);
    const before = await auditRows(ctx);
    const { next } = await page(ctx.app, admin.headers);
    await page(ctx.app, admin.headers, { before: next ?? "" });
    await page(ctx.app, admin.headers, { actor: a.identityId, action: "photo.view" });
    await page(ctx.app, admin.headers, { subjectType: "photo" });
    expect((await audit(ctx.app, admin.headers, { before: "!!!" })).status).toBe(400);
    expect((await audit(ctx.app, admin.headers, { actor: "x" })).status).toBe(400);
    // A refused read narrowed to a subject writes nothing either.
    expect(
      (await audit(ctx.app, admin.headers, { subjectId: ACCOUNT_1, before: "!!!" })).status,
    ).toBe(400);
    expect(await auditRows(ctx)).toEqual(before);
  });

  test.for([
    ["an account", { subjectType: "account", subjectId: ACCOUNT_1 }, "account"],
    ["a photo", { subjectType: "photo", subjectId: PHOTO_1 }, "photo"],
    // A report opened or decided (#312) names the report, never a person.
    ["a report", { subjectType: "report", subjectId: ACCOUNT_2 }, "report"],
    ["an id of no named type", { subjectId: ACCOUNT_2 }, "any"],
    ["an id of a type no row names", { subjectType: "identity", subjectId: ACCOUNT_2 }, "any"],
  ] as const)(
    "a read narrowed to %s writes audit.read about it before it reads, and shows it",
    async ([, query, recorded], { ctx }) => {
      const { a, admin } = await cast(ctx);
      await rowsIn(ctx, a.identityId, 3);
      const before = (await auditRows(ctx)).length;
      const answer = await page(ctx.app, admin.headers, query);
      const rows = await auditRows(ctx);
      expect(rows).toHaveLength(before + 1);
      expect(rows.filter((row) => row.action === "audit.read")).toEqual([
        expect.objectContaining({
          actor_identity_id: admin.identityId,
          subject_type: recorded,
          subject_id: query.subjectId,
          detail: null,
        }),
      ]);
      // Written first, in the same transaction: the read sees its own row unless its type filter leaves that row out.
      const unnarrowed = !("subjectType" in query);
      expect(answer.items.some((item) => item.action === "audit.read")).toBe(
        unnarrowed || query.subjectType === recorded,
      );
    },
  );

  test("the guard answers before the query is read: no session 401, a moderator 403, whatever the query", async ({
    ctx,
  }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const queries: Query[] = [{ before: "!!!" }, { actor: "x" }];
    for (const query of queries) {
      const anonymous = await audit(ctx.app, {}, query);
      expect(anonymous.status).toBe(401);
      expect(await errorCode(anonymous)).toBe("unauthenticated");
      const refused = await audit(ctx.app, moderator.headers, query);
      expect(refused.status).toBe(403);
      expect(await errorCode(refused)).toBe("admin_forbidden");
    }
  });
});

/** A member of staff without a session: an identity and a moderator_roles row as the CLI writes it. */
