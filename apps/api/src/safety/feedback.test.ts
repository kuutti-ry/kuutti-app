import { CURRENT_CONSENT_VERSIONS } from "../identity/index.ts";
import { signedInAccount, staffSession, withMatchingConfig } from "../test/account.ts";
import { describe, expect, type TestContext, test } from "../test/harness.ts";
import { recordFeedback } from "./feedback.ts";

// Feedback from inside the app (#171, ADR-023, features/safety/feedback.feature):
// the member route, the panel's routes, the cap, the event and the log.

// A marker of letters: a number such as 4711 can turn up in a log line's
// millisecond timestamp and fail the test by chance.
const MARK = "qzxv";
const TEXT = `The photos screen shows yesterday's tip ${MARK}.`;
const json = (headers: Record<string, string>) => ({
  ...headers,
  "content-type": "application/json",
});
const body = (patch: Record<string, unknown> = {}) => ({
  kind: "bug",
  text: TEXT,
  appVersion: "0.22.0",
  platform: "ios",
  locale: "fi",
  ...patch,
});
const send = (ctx: TestContext, headers: Record<string, string>, patch = {}) =>
  ctx.app.request("/feedback", {
    method: "POST",
    headers: json(headers),
    body: JSON.stringify(body(patch)),
  });
const errorCode = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;
const rowsOf = async (ctx: TestContext, accountId: string) =>
  (
    await ctx.client.query<{
      kind: string;
      text: string;
      app_version: string;
      platform: string;
      locale: string;
      handled_at: Date | null;
    }>(
      "SELECT kind, text, app_version, platform, locale, handled_at FROM feedback WHERE account_id = $1 ORDER BY created_at",
      [accountId],
    )
  ).rows;
const list = (ctx: TestContext, headers: Record<string, string>, query = "") =>
  ctx.app.request(`/admin/feedback${query}`, { headers });
const handle = (ctx: TestContext, headers: Record<string, string>, id: string) =>
  ctx.app.request(`/admin/feedback/${id}/handled`, { method: "POST", headers });

describe("Feedback of each kind lands with the build, and its text in no log line", () => {
  test.for([
    ["bug", "ios", "fi"],
    ["idea", "android", "sv"],
    ["complaint", "web", "en"],
    ["praise", "ios", "en"],
  ] as const)("%s from %s in %s", async ([kind, platform, locale], { ctx }) => {
    const a = await signedInAccount(ctx.client);
    const response = await send(ctx, a.headers, { kind, platform, locale });
    expect(response.status).toBe(204);
    expect(await rowsOf(ctx, a.accountId)).toEqual([
      { kind, text: TEXT, app_version: "0.22.0", platform, locale, handled_at: null },
    ]);
    const lines = ctx.logs();
    expect(lines.find((l) => l.msg === "feedback sent")).toMatchObject({
      accountId: a.accountId,
      kind,
      appVersion: "0.22.0",
      platform,
      locale,
    });
    expect(JSON.stringify(lines)).not.toContain(TEXT);
    expect(JSON.stringify(lines)).not.toContain(MARK);
  });
});

describe("the feedback route's edges", () => {
  test.for([
    ["an empty text", { text: "" }],
    ["a text of spaces", { text: "   " }],
    ["a text over the cap", { text: "x".repeat(2001) }],
    ["an unknown kind", { kind: "question" }],
    ["an unknown platform", { platform: "windows" }],
    ["a missing version", { appVersion: undefined }],
    ["an extra field", { attachment: "x" }],
  ] as const)("refuses %s with 400 and stores nothing", async ([, patch], { ctx }) => {
    const a = await signedInAccount(ctx.client);
    const response = await send(ctx, a.headers, patch);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("validation_failed");
    expect(await rowsOf(ctx, a.accountId)).toEqual([]);
  });

  test("a request that outlived the deletion writes nothing for the erased account", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    await ctx.client.query(
      "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
      [a.accountId],
    );
    const at = new Date();
    const record = await recordFeedback(ctx.client, {
      ...body(),
      kind: "bug",
      platform: "ios",
      accountId: a.accountId,
      at,
      since: new Date(at.getTime() - 3_600_000),
      limit: 5,
    });
    expect(record).toEqual({ live: false, used: 0, id: null });
    // Through the route the guard or the record refuses; either way nothing is written.
    expect([401, 404]).toContain((await send(ctx, a.headers)).status);
    expect(await rowsOf(ctx, a.accountId)).toEqual([]);
  });
});

describe("the day's cap and the event", () => {
  test("The sixth send of a day is refused in words", async ({ ctx }) => {
    await withMatchingConfig(ctx.client, { feedback_per_day: 5 });
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    for (let i = 0; i < 5; i += 1) expect((await send(ctx, a.headers)).status).toBe(204);
    const refused = await send(ctx, a.headers);
    expect(refused.status).toBe(429);
    expect(await errorCode(refused)).toBe("feedback_budget_exceeded");
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect((await rowsOf(ctx, a.accountId)).length).toBe(5);
    expect(ctx.logs().find((l) => l.msg === "feedback refused")).toMatchObject({
      accountId: a.accountId,
      used: 5,
      limit: 5,
      reason: "budget",
    });
    expect((await send(ctx, b.headers)).status).toBe(204);
  });

  test("The research event carries the kind alone", async ({ ctx }) => {
    const enrolled = await signedInAccount(ctx.client);
    const outside = await signedInAccount(ctx.client);
    const consent = await ctx.app.request("/consents", {
      method: "POST",
      headers: json(enrolled.headers),
      body: JSON.stringify({
        kind: "research",
        version: CURRENT_CONSENT_VERSIONS.research,
        locale: "fi",
      }),
    });
    expect(consent.status).toBe(200);
    expect((await send(ctx, enrolled.headers, { kind: "idea" })).status).toBe(204);
    expect((await send(ctx, outside.headers, { kind: "praise" })).status).toBe(204);
    const { rows } = await ctx.client.query<{ props: unknown; account_id: string }>(
      `SELECT e.props, s.account_id FROM events e
       JOIN research_subject s ON s.research_id = e.research_id
       WHERE e.name = 'feedback_sent'`,
    );
    expect(rows).toEqual([{ props: { kind: "idea" }, account_id: enrolled.accountId }]);
    const all = await ctx.client.query<{ n: string }>(
      "SELECT count(*) AS n FROM events WHERE name = 'feedback_sent'",
    );
    expect(Number(all.rows[0]?.n)).toBe(1);
    expect(JSON.stringify(rows)).not.toContain(TEXT);
  });
});

describe("the panel", () => {
  test("The panel lists what waits, a bug first and praise last", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const staff = await staffSession(ctx.client);
    for (const kind of ["praise", "idea", "complaint", "bug", "praise"]) {
      expect((await send(ctx, a.headers, { kind })).status).toBe(204);
    }
    const page = (await (await list(ctx, staff.headers)).json()) as {
      items: Array<{ id: string; kind: string; accountId: string; handledAt: null }>;
      total: number;
    };
    expect(page.total).toBe(5);
    expect(page.items.map((i) => i.kind)).toEqual(["bug", "complaint", "idea", "praise", "praise"]);
    expect(page.items.every((i) => i.accountId === a.accountId && i.handledAt === null)).toBe(true);
    const first = page.items[0];
    if (!first) throw new Error("no items");
    expect((await handle(ctx, staff.headers, first.id)).status).toBe(200);
    const after = (await (await list(ctx, staff.headers, "?limit=2")).json()) as {
      items: Array<{ kind: string }>;
      total: number;
    };
    expect(after.total).toBe(4);
    expect(after.items.map((i) => i.kind)).toEqual(["complaint", "idea"]);
    expect((await list(ctx, staff.headers, "?limit=0")).status).toBe(400);
  });

  test("Marking feedback handled is an audit row, once", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const staff = await staffSession(ctx.client);
    expect((await send(ctx, a.headers, { kind: "complaint" })).status).toBe(204);
    const page = (await (await list(ctx, staff.headers)).json()) as {
      items: Array<{ id: string }>;
    };
    const id = page.items[0]?.id;
    if (!id) throw new Error("no item");
    const marked = await handle(ctx, staff.headers, id);
    expect(marked.status).toBe(200);
    const answer = (await marked.json()) as { id: string; handledAt: string };
    expect(answer.id).toBe(id);
    const row = await ctx.client.query<{ handled_at: Date; handled_by: string }>(
      "SELECT handled_at, handled_by FROM feedback WHERE id = $1",
      [id],
    );
    expect(row.rows[0]?.handled_by).toBe(staff.identityId);
    expect(row.rows[0]?.handled_at.toISOString()).toBe(answer.handledAt);
    const audit = await ctx.client.query<{
      actor_identity_id: string;
      action: string;
      subject_type: string;
      subject_id: string;
      detail: unknown;
    }>("SELECT actor_identity_id, action, subject_type, subject_id, detail FROM audit_log");
    expect(audit.rows).toEqual([
      {
        actor_identity_id: staff.identityId,
        action: "feedback.handle",
        subject_type: "feedback",
        subject_id: id,
        detail: { kind: "complaint" },
      },
    ]);
    const again = await handle(ctx, staff.headers, id);
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("feedback_handled");
    expect((await handle(ctx, staff.headers, "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01")).status).toBe(
      404,
    );
    // The refusal rolled its audit row back: one row, the first marking's.
    expect((await ctx.client.query("SELECT 1 FROM audit_log")).rowCount).toBe(1);
    expect(ctx.logs().find((l) => l.msg === "feedback handled")).toMatchObject({
      staffIdentityId: staff.identityId,
      feedbackId: id,
      kind: "complaint",
    });
    expect(JSON.stringify(ctx.logs())).not.toContain(TEXT);
  });

  test("Feedback refuses without a session, and the panel refuses a member", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const moderator = await staffSession(ctx.client);
    const researcher = await staffSession(ctx.client, "researcher");
    for (const headers of [{}, moderator.headers]) {
      expect((await send(ctx, headers)).status).toBe(401);
    }
    const id = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01";
    for (const headers of [{}, a.headers]) {
      expect((await list(ctx, headers)).status).toBe(401);
      expect((await handle(ctx, headers, id)).status).toBe(401);
    }
    expect((await list(ctx, researcher.headers)).status).toBe(403);
    expect((await handle(ctx, researcher.headers, id)).status).toBe(403);
    expect(await rowsOf(ctx, a.accountId)).toEqual([]);
  });
});
