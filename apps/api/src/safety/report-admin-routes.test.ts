import type { Queryable } from "@kuutti/db";
import { ErrorResponse, ReportQueue } from "@kuutti/schema";
import { type App, createApp } from "../app.ts";
import { type SignedIn, signedInAccount, staffSession } from "../test/account.ts";
import { conversationBetween } from "../test/chat.ts";
import {
  test as base,
  captureLogger,
  describe,
  expect,
  type TestContext,
  testConfig,
} from "../test/harness.ts";

// The panel's report queue (#311, features/safety/report-queue.feature): the
// order of what waits and its groups, both people's figures, the closed
// filter, the recusal of staff who are a party, nothing of a note or a
// conversation in the answer, the query's bounds, and the moderators' guard.
// Reports are written straight into the test's transaction in the states
// filing and #312's decision leave them in, except where the words a report
// carries are the point: those are filed through the route.

/** The route's clock: 12:00 in Finland, one Friday. */
const T = new Date("2026-10-16T09:00:00.000Z");

type Headers = Record<string, string>;

async function appOn(db: Queryable): Promise<App> {
  const { logger } = await captureLogger();
  return createApp({ config: testConfig(), logger, db, now: () => T });
}

const test = base.extend<{ app: App }>({
  app: async ({ ctx }, use) => {
    await use(await appOn(ctx.client));
  },
});

const queue = (app: App, headers: Headers, query = "") =>
  app.request(`/admin/reports${query}`, { headers });

async function read(app: App, headers: Headers, query = ""): Promise<ReportQueue> {
  const response = await queue(app, headers, query);
  expect(response.status).toBe(200);
  return ReportQueue.parse(await response.json());
}

async function errorCode(response: Response): Promise<string> {
  return ErrorResponse.parse(await response.json()).error.code;
}

/** A report from `reporter` about `reported`, filed at `created`; decided when `decided` is given. */
async function reportIn(
  ctx: TestContext,
  reporter: string,
  reported: string,
  created: string,
  decided?: { outcome: "dismissed" | "acted"; at: string; by: string },
  source: "card" | "conversation" = "card",
): Promise<string> {
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO report (reporter_account_id, reported_account_id, source, reason, created_at,
                         outcome, decided_at, decided_by)
     VALUES ($1, $2, $3, 'harassment', $4, $5, $6, $7) RETURNING id`,
    [
      reporter,
      reported,
      source,
      created,
      decided?.outcome ?? null,
      decided?.at ?? null,
      decided?.by ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("test report not written");
  return id;
}

/** A sanction on the account, as #307 leaves it; lifted when `lifted` is given. */
async function sanctionOn(ctx: TestContext, accountId: string, lifted?: string): Promise<void> {
  await ctx.client.query(
    `INSERT INTO sanction (identity_id, account_id, kind, reason, note, lifted_at)
     SELECT identity_id, id, 'warn', 'harassment', 'Kept asking for an address.', $2
       FROM account WHERE id = $1`,
    [accountId, lifted ?? null],
  );
}

/** A second account of the staff member's own identity, as a person who also uses the app. */
async function accountOf(ctx: TestContext, identityId: string, state = "active"): Promise<string> {
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO account (identity_id, state, birth_year, birth_month)
     VALUES ($1, $2, 1990, 6) RETURNING id`,
    [identityId, state],
  );
  return rows[0]?.id as string;
}

async function people(ctx: TestContext, n: number): Promise<SignedIn[]> {
  const out: SignedIn[] = [];
  for (let i = 0; i < n; i++) out.push(await signedInAccount(ctx.client));
  return out;
}

async function auditRows(ctx: TestContext) {
  return (await ctx.client.query("SELECT * FROM audit_log ORDER BY at, id")).rows;
}

describe("GET /admin/reports", () => {
  test("Reports waiting are listed the oldest first, those about one person together", async ({
    ctx,
    app,
  }) => {
    const staff = await staffSession(ctx.client);
    const [a, b, c, x, y] = await people(ctx, 5);
    if (!a || !b || !c || !x || !y) throw new Error("people not written");
    // Inserted out of order, so the answer cannot be the order rows went in.
    const yReport = await reportIn(ctx, c.accountId, y.accountId, "2026-10-15T10:00:00.000Z");
    const xLater = await reportIn(ctx, b.accountId, x.accountId, "2026-10-15T12:00:00.000Z");
    const xFirst = await reportIn(ctx, a.accountId, x.accountId, "2026-10-15T08:00:00.000Z");

    const page = await read(app, staff.headers);
    expect(page.items.map((item) => item.id)).toEqual([xFirst, xLater, yReport]);
    expect(page.items.map((item) => item.reported.accountId)).toEqual([
      x.accountId,
      x.accountId,
      y.accountId,
    ]);
    expect(page.total).toBe(3);
    expect(page.now).toBe(T.toISOString());
    expect(page.responseHours).toBe(24);
    expect(page.items[0]).toEqual({
      id: xFirst,
      reason: "harassment",
      source: "card",
      createdAt: "2026-10-15T08:00:00.000Z",
      outcome: null,
      decidedAt: null,
      reporter: { accountId: a.accountId, filed: 1, upheld: 0 },
      reported: { accountId: x.accountId, received: 2, sanctions: 0 },
    });
  });

  test("a group is placed by its oldest report, however new its others are", async ({
    ctx,
    app,
  }) => {
    const staff = await staffSession(ctx.client);
    const [a, b, c, x, y] = await people(ctx, 5);
    if (!a || !b || !c || !x || !y) throw new Error("people not written");
    const yOnly = await reportIn(ctx, c.accountId, y.accountId, "2026-10-14T00:00:00.000Z");
    const xOld = await reportIn(ctx, a.accountId, x.accountId, "2026-10-13T00:00:00.000Z");
    const xNew = await reportIn(ctx, b.accountId, x.accountId, "2026-10-16T08:00:00.000Z");
    expect((await read(app, staff.headers)).items.map((item) => item.id)).toEqual([
      xOld,
      xNew,
      yOnly,
    ]);
  });

  test("Each report shows how both people have figured in reports before", async ({ ctx, app }) => {
    const staff = await staffSession(ctx.client);
    const [a, x, p, q, r] = await people(ctx, 5);
    if (!a || !x || !p || !q || !r) throw new Error("people not written");
    // A filed three: one upheld, one dismissed, and the one waiting.
    await reportIn(ctx, a.accountId, p.accountId, "2026-09-01T08:00:00.000Z", {
      outcome: "acted",
      at: "2026-09-02T08:00:00.000Z",
      by: staff.identityId,
    });
    await reportIn(ctx, a.accountId, q.accountId, "2026-09-03T08:00:00.000Z", {
      outcome: "dismissed",
      at: "2026-09-04T08:00:00.000Z",
      by: staff.identityId,
    });
    const waiting = await reportIn(ctx, a.accountId, x.accountId, "2026-10-15T08:00:00.000Z");
    // X had one report before, dismissed, and a sanction since lifted.
    await reportIn(ctx, r.accountId, x.accountId, "2026-08-01T08:00:00.000Z", {
      outcome: "dismissed",
      at: "2026-08-02T08:00:00.000Z",
      by: staff.identityId,
    });
    await sanctionOn(ctx, x.accountId, "2026-08-10T08:00:00.000Z");
    // Somebody else's sanction is not X's.
    await sanctionOn(ctx, p.accountId);

    const [item] = (await read(app, staff.headers)).items;
    expect(item?.id).toBe(waiting);
    expect(item?.reporter).toEqual({ accountId: a.accountId, filed: 3, upheld: 1 });
    expect(item?.reported).toEqual({ accountId: x.accountId, received: 2, sanctions: 1 });
  });

  test("Decided reports are behind the closed filter, the newest decision first", async ({
    ctx,
    app,
  }) => {
    const staff = await staffSession(ctx.client);
    const [a, b, x] = await people(ctx, 3);
    if (!a || !b || !x) throw new Error("people not written");
    const open = await reportIn(ctx, a.accountId, x.accountId, "2026-10-15T08:00:00.000Z");
    // Filed first, decided last: the decision orders the record, not the filing.
    const decidedLast = await reportIn(ctx, b.accountId, x.accountId, "2026-10-01T08:00:00.000Z", {
      outcome: "acted",
      at: "2026-10-12T08:00:00.000Z",
      by: staff.identityId,
    });
    const decidedFirst = await reportIn(
      ctx,
      a.accountId,
      x.accountId,
      "2026-10-05T08:00:00.000Z",
      { outcome: "dismissed", at: "2026-10-06T08:00:00.000Z", by: staff.identityId },
      "conversation",
    );

    const closed = await read(app, staff.headers, "?state=closed");
    expect(closed.items.map((item) => [item.id, item.outcome, item.decidedAt])).toEqual([
      [decidedLast, "acted", "2026-10-12T08:00:00.000Z"],
      [decidedFirst, "dismissed", "2026-10-06T08:00:00.000Z"],
    ]);
    expect(closed.items[1]?.source).toBe("conversation");
    expect(closed.total).toBe(2);
    const waiting = await read(app, staff.headers, "?state=open");
    expect(waiting.items.map((item) => item.id)).toEqual([open]);
    expect(waiting.total).toBe(1);
  });

  test("a page holds the limit and the total counts beyond it", async ({ ctx, app }) => {
    const staff = await staffSession(ctx.client);
    const [a, b, c, x] = await people(ctx, 4);
    if (!a || !b || !c || !x) throw new Error("people not written");
    const first = await reportIn(ctx, a.accountId, x.accountId, "2026-10-14T08:00:00.000Z");
    const second = await reportIn(ctx, b.accountId, x.accountId, "2026-10-14T09:00:00.000Z");
    await reportIn(ctx, c.accountId, x.accountId, "2026-10-14T10:00:00.000Z");
    const page = await read(app, staff.headers, "?limit=2");
    expect(page.items.map((item) => item.id)).toEqual([first, second]);
    expect(page.total).toBe(3);
  });

  test("an empty queue answers no items and a total of zero, in either state", async ({
    ctx,
    app,
  }) => {
    const staff = await staffSession(ctx.client);
    for (const query of ["", "?state=closed"]) {
      const page = await read(app, staff.headers, query);
      expect(page.items, query).toEqual([]);
      expect(page.total, query).toBe(0);
    }
  });

  test("A member of staff who is a party to a report is not shown it", async ({ ctx, app }) => {
    const m = await staffSession(ctx.client);
    const other = await staffSession(ctx.client);
    const [x, y, z] = await people(ctx, 3);
    if (!x || !y || !z) throw new Error("people not written");
    // M uses the app too, and once did with an account since erased.
    const mine = await accountOf(ctx, m.identityId);
    const erased = await accountOf(ctx, m.identityId, "deleted");
    const byM = await reportIn(ctx, mine, x.accountId, "2026-10-15T08:00:00.000Z");
    const aboutM = await reportIn(ctx, y.accountId, mine, "2026-10-15T09:00:00.000Z");
    const aboutErased = await reportIn(ctx, z.accountId, erased, "2026-10-15T10:00:00.000Z");
    // A report M is no party to: by Y, who also reported M, about X, whom M also reported.
    const neither = await reportIn(ctx, y.accountId, x.accountId, "2026-10-15T11:00:00.000Z");
    // Decided ones the same, behind the filter.
    await reportIn(ctx, x.accountId, mine, "2026-10-01T08:00:00.000Z", {
      outcome: "dismissed",
      at: "2026-10-02T08:00:00.000Z",
      by: other.identityId,
    });

    const forM = await read(app, m.headers);
    expect(forM.items.map((item) => item.id)).toEqual([neither]);
    expect(forM.total).toBe(1);
    // Y filed two and X received two, one of each M's own: M counts neither of those.
    expect(forM.items[0]?.reporter).toEqual({ accountId: y.accountId, filed: 1, upheld: 0 });
    expect(forM.items[0]?.reported).toEqual({ accountId: x.accountId, received: 1, sanctions: 0 });
    expect((await read(app, m.headers, "?state=closed")).total).toBe(0);
    const front = await app.request("/admin/overview", { headers: m.headers });
    const reports = (await front.json()).queues.find(
      (q: { queue: string }) => q.queue === "reports",
    );
    expect(reports).toEqual({
      queue: "reports",
      waiting: 1,
      oldestSince: "2026-10-15T11:00:00.000Z",
    });

    const forOther = await read(app, other.headers);
    expect(forOther.items.map((item) => item.id)).toEqual([byM, neither, aboutM, aboutErased]);
    expect(forOther.items[1]?.reporter).toEqual({ accountId: y.accountId, filed: 2, upheld: 0 });
    expect(forOther.items[1]?.reported).toEqual({
      accountId: x.accountId,
      received: 2,
      sanctions: 0,
    });
    expect((await read(app, other.headers, "?state=closed")).total).toBe(1);
  });

  test("The queue carries nothing of the reporter's words or the conversation", async ({
    ctx,
    app,
  }) => {
    const staff = await staffSession(ctx.client);
    const [a, b] = await people(ctx, 2);
    if (!a || !b) throw new Error("people not written");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: [
        { from: "a", body: "Moikka, mitä kuuluu?" },
        { from: "b", body: "Missä asut tarkalleen?" },
      ],
    });
    const filed = await ctx.app.request(`/conversations/${id}/report`, {
      method: "POST",
      headers: { ...a.headers, "content-type": "application/json" },
      body: JSON.stringify({ reason: "harassment", note: "Kysyy aina kotiosoitettani" }),
    });
    expect(filed.status).toBe(204);
    const copied = await ctx.client.query("SELECT count(*)::int AS n FROM report_message");
    expect(copied.rows[0]?.n).toBe(2);

    const response = await queue(app, staff.headers);
    expect(response.status).toBe(200);
    const text = await response.text();
    const [item] = ReportQueue.parse(JSON.parse(text)).items;
    expect(item?.source).toBe("conversation");
    expect(item?.reported.accountId).toBe(b.accountId);
    for (const words of ["Moikka", "Missä asut", "kotiosoitettani", id]) {
      expect(text).not.toContain(words);
    }
  });

  test.for([
    ["a state outside the two", "?state=pending"],
    ["a limit of zero", "?limit=0"],
    ["a limit past a hundred", "?limit=101"],
    ["a limit that is no number", "?limit=many"],
  ] as const)("%s is refused with 400", async ([, query], { ctx, app }) => {
    const staff = await staffSession(ctx.client);
    const response = await queue(app, staff.headers, query);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("validation_failed");
  });

  test("a moderator and an admin both read it, and no audit row is written", async ({
    ctx,
    app,
  }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const admin = await staffSession(ctx.client, "admin");
    const [a, x] = await people(ctx, 2);
    if (!a || !x) throw new Error("people not written");
    await reportIn(ctx, a.accountId, x.accountId, "2026-10-15T08:00:00.000Z");
    const before = await auditRows(ctx);
    const answers = [];
    for (const staff of [moderator, admin]) answers.push(await read(app, staff.headers));
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]?.total).toBe(1);
    expect(await auditRows(ctx)).toEqual(before);
  });

  test("without a session the answer is 401, and a researcher is refused with 403", async ({
    ctx,
    app,
  }) => {
    const member = await signedInAccount(ctx.client);
    const researcher = await staffSession(ctx.client, "researcher");
    for (const [what, headers] of [
      ["no token", {}],
      ["a product session's token", member.headers],
    ] as const) {
      const response = await queue(app, headers);
      expect(response.status, what).toBe(401);
      expect(await errorCode(response), what).toBe("unauthenticated");
    }
    const refused = await queue(app, researcher.headers);
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe("admin_forbidden");
  });
});
