import type { Queryable } from "@kuutti/db";
import { AdminOverview, ErrorResponse } from "@kuutti/schema";
import { type App, createApp } from "../app.ts";
import { signedInAccount, staffSession } from "../test/account.ts";
import {
  test as base,
  captureLogger,
  describe,
  expect,
  type TestContext,
  testConfig,
} from "../test/harness.ts";
import { MODERATION_RESPONSE_HOURS_KEY } from "./overview-routes.ts";

// The panel's front page (#303): the figures read back exactly as the queues
// hold them, reports by their filing (#311), photos by the later of upload
// and appeal, feedback by its sending; the API's clock and the promised response time ride along; the
// moderators' guard in each of its variants; and no audit row, since the page
// shows counts of queues and nothing about a person. Rows are written straight
// into the test's transaction in the states moderation leaves them in.

/** The route's clock: 12:00 in Finland, one Friday. */
const T = new Date("2026-10-16T09:00:00.000Z");

type Headers = Record<string, string>;

async function appOn(db: Queryable, now: () => Date = () => T): Promise<App> {
  const { logger } = await captureLogger();
  return createApp({ config: testConfig(), logger, db, now });
}

const test = base.extend<{ app: App }>({
  app: async ({ ctx }, use) => {
    await use(await appOn(ctx.client));
  },
});

const overview = (app: App, headers: Headers) => app.request("/admin/overview", { headers });

async function read(app: App, headers: Headers): Promise<AdminOverview> {
  const response = await overview(app, headers);
  expect(response.status).toBe(200);
  return AdminOverview.parse(await response.json());
}

async function errorCode(response: Response): Promise<string> {
  return ErrorResponse.parse(await response.json()).error.code;
}

type PhotoState = "pending" | "queued" | "approved" | "rejected";

/**
 * A photo uploaded at `created`, and, when `review` is given, the review row
 * moderation leaves beside it: the check's decision and the owner's appeal.
 */
async function photoIn(
  ctx: TestContext,
  accountId: string,
  state: PhotoState,
  created: string,
  review?: { decision: "approved" | "queued" | "rejected"; appealed: string | null },
): Promise<string> {
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO photo (account_id, key, blurhash, width, height, state, position, created_at)
     VALUES ($1, $2, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 800, 1067, $3,
             (SELECT coalesce(max(position) + 1, 0) FROM photo WHERE account_id = $1), $4)
     RETURNING id`,
    [accountId, `k-${state}-${created}`, state, created],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("test photo not written");
  if (review) {
    await ctx.client.query(
      `INSERT INTO photo_review (photo_id, labels, faces, flagged, checked_at, decision, appealed_at)
       VALUES ($1, '[]'::jsonb, 1, '{}', $2, $3, $4)`,
      [id, created, review.decision, review.appealed],
    );
  }
  return id;
}

/** Feedback sent at `created`; handled at `handled` by `handledBy` when given. */
async function feedbackIn(
  ctx: TestContext,
  accountId: string,
  created: string,
  handled?: { at: string; by: string },
): Promise<void> {
  await ctx.client.query(
    `INSERT INTO feedback (account_id, kind, text, app_version, platform, locale, created_at, handled_at, handled_by)
     VALUES ($1, 'bug', 'The photos screen stays blank.', '0.22.0', 'ios', 'fi', $2, $3, $4)`,
    [accountId, created, handled?.at ?? null, handled?.by ?? null],
  );
}

/** What moderation leaves behind and nobody waits for: three photos past or before the queue, one handled feedback. */
async function nothingWaiting(ctx: TestContext, accountId: string, handledBy: string) {
  await photoIn(ctx, accountId, "approved", "2026-10-01T08:00:00.000Z", {
    decision: "approved",
    appealed: null,
  });
  // Appealed, looked at by a person, and rejected again: the appeal stays on the row.
  await photoIn(ctx, accountId, "rejected", "2026-10-01T09:00:00.000Z", {
    decision: "rejected",
    appealed: "2026-10-02T09:00:00.000Z",
  });
  // Not checked yet: no review row, and not the human queue's.
  await photoIn(ctx, accountId, "pending", "2026-10-01T10:00:00.000Z");
  await feedbackIn(ctx, accountId, "2026-10-01T11:00:00.000Z", {
    at: "2026-10-02T11:00:00.000Z",
    by: handledBy,
  });
}

async function auditRows(ctx: TestContext) {
  return (await ctx.client.query("SELECT * FROM audit_log ORDER BY at, id")).rows;
}

describe("GET /admin/overview", () => {
  test("The figures match the queues", async ({ ctx, app }) => {
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    // Uploaded first, but rejected by the check and appealed later than the
    // other photo's upload: it waits from its appeal, so it is not the oldest.
    await photoIn(ctx, owner.accountId, "queued", "2026-10-14T06:00:00.000Z", {
      decision: "queued",
      appealed: "2026-10-16T08:00:00.000Z",
    });
    // Sent to a person by the check, never appealed: it waits from its upload.
    await photoIn(ctx, owner.accountId, "queued", "2026-10-15T20:00:00.000Z", {
      decision: "queued",
      appealed: null,
    });
    await feedbackIn(ctx, owner.accountId, "2026-10-15T12:34:56.789Z");
    await nothingWaiting(ctx, owner.accountId, staff.identityId);

    expect(await read(app, staff.headers)).toEqual({
      now: "2026-10-16T09:00:00.000Z",
      responseHours: 24,
      queues: [
        { queue: "reports", waiting: 0, oldestSince: null },
        { queue: "photos", waiting: 2, oldestSince: "2026-10-15T20:00:00.000Z" },
        { queue: "feedback", waiting: 1, oldestSince: "2026-10-15T12:34:56.789Z" },
      ],
    });
  });

  test("reports wait from their filing, and a decided one is not counted", async ({ ctx, app }) => {
    const staff = await staffSession(ctx.client);
    const [a, b, x] = [
      await signedInAccount(ctx.client),
      await signedInAccount(ctx.client),
      await signedInAccount(ctx.client),
    ];
    const file = (reporter: string, at: string, decided: boolean) =>
      ctx.client.query(
        `INSERT INTO report (reporter_account_id, reported_account_id, source, reason, created_at,
                             outcome, decided_at, decided_by)
         VALUES ($1, $2, 'card', 'harassment', $3, $4, $5, $6)`,
        decided
          ? [reporter, x.accountId, at, "dismissed", "2026-10-15T00:00:00.000Z", staff.identityId]
          : [reporter, x.accountId, at, null, null, null],
      );
    // The oldest was decided: it no longer waits, and the next one is the oldest.
    await file(a.accountId, "2026-10-10T08:00:00.000Z", true);
    await file(a.accountId, "2026-10-15T07:30:00.000Z", false);
    await file(b.accountId, "2026-10-16T08:00:00.000Z", false);
    expect((await read(app, staff.headers)).queues[0]).toEqual({
      queue: "reports",
      waiting: 2,
      oldestSince: "2026-10-15T07:30:00.000Z",
    });
  });

  test("an appeal earlier than every other upload is the oldest, and a photo without a review row waits from its upload", async ({
    ctx,
    app,
  }) => {
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    const other = await signedInAccount(ctx.client);
    // Inserted newest first, so the answer cannot be the order rows went in.
    await photoIn(ctx, other.accountId, "queued", "2026-10-15T07:00:00.000Z");
    await photoIn(ctx, owner.accountId, "queued", "2026-10-12T06:00:00.000Z", {
      decision: "rejected",
      appealed: "2026-10-13T10:15:00.000Z",
    });
    await photoIn(ctx, owner.accountId, "queued", "2026-10-14T06:00:00.000Z");
    await feedbackIn(ctx, other.accountId, "2026-10-16T08:59:59.999Z");
    await feedbackIn(ctx, owner.accountId, "2026-10-11T00:00:00.001Z");
    await feedbackIn(ctx, owner.accountId, "2026-10-13T00:00:00.000Z");

    expect((await read(app, staff.headers)).queues).toEqual([
      { queue: "reports", waiting: 0, oldestSince: null },
      { queue: "photos", waiting: 3, oldestSince: "2026-10-13T10:15:00.000Z" },
      { queue: "feedback", waiting: 3, oldestSince: "2026-10-11T00:00:00.001Z" },
    ]);
  });

  test("an empty panel answers zero and null for every queue", async ({ ctx, app }) => {
    const staff = await staffSession(ctx.client);
    expect(await read(app, staff.headers)).toEqual({
      now: "2026-10-16T09:00:00.000Z",
      responseHours: 24,
      queues: [
        { queue: "reports", waiting: 0, oldestSince: null },
        { queue: "photos", waiting: 0, oldestSince: null },
        { queue: "feedback", waiting: 0, oldestSince: null },
      ],
    });
  });

  test("approved, rejected and pending photos and handled feedback are not counted", async ({
    ctx,
    app,
  }) => {
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    await nothingWaiting(ctx, owner.accountId, staff.identityId);
    expect((await read(app, staff.headers)).queues).toEqual([
      { queue: "reports", waiting: 0, oldestSince: null },
      { queue: "photos", waiting: 0, oldestSince: null },
      { queue: "feedback", waiting: 0, oldestSince: null },
    ]);
  });

  test("now is the API's clock, not the moment of the request", async ({ ctx }) => {
    const staff = await staffSession(ctx.client);
    for (const at of ["2026-10-16T09:00:00.000Z", "2027-01-01T00:00:00.000Z"]) {
      const app = await appOn(ctx.client, () => new Date(at));
      expect((await read(app, staff.headers)).now).toBe(at);
    }
  });

  test("without a clock of its own the app answers with the present", async ({ ctx }) => {
    const staff = await staffSession(ctx.client);
    // The harness's app passes no now: the route falls back to the system clock.
    const before = Date.now();
    const { now } = await read(ctx.app, staff.headers);
    const after = Date.now();
    expect(Date.parse(now)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(now)).toBeLessThanOrEqual(after);
  });

  test("responseHours is the config row's and follows a new version", async ({ ctx, app }) => {
    const staff = await staffSession(ctx.client);
    const { rows } = await ctx.client.query<{ version: number; value: unknown }>(
      "SELECT version, value FROM matching_config WHERE key = $1 ORDER BY version",
      [MODERATION_RESPONSE_HOURS_KEY],
    );
    expect(rows).toEqual([{ version: 1, value: 24 }]);
    expect((await read(app, staff.headers)).responseHours).toBe(24);
    await ctx.client.query(
      `INSERT INTO matching_config (version, key, value, created_by, reason)
       VALUES (2, $1, '36'::jsonb, 'admin', 'Summer: two moderators away')`,
      [MODERATION_RESPONSE_HOURS_KEY],
    );
    expect((await read(app, staff.headers)).responseHours).toBe(36);
  });

  test.for([
    ["missing", null, "matching_config has no row for moderation_response_hours"],
    ["not a number", '"24"', "matching_config moderation_response_hours is not a number"],
  ] as const)("a response time %s fails closed with 500", async ([, value, line], { ctx }) => {
    const { logger, lines } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: ctx.client, now: () => T });
    const staff = await staffSession(ctx.client);
    if (value === null) {
      await ctx.client.query("DELETE FROM matching_config WHERE key = $1", [
        MODERATION_RESPONSE_HOURS_KEY,
      ]);
    } else {
      await ctx.client.query(
        `INSERT INTO matching_config (version, key, value, created_by) VALUES (2, $1, $2::jsonb, 'test')`,
        [MODERATION_RESPONSE_HOURS_KEY, value],
      );
    }
    const response = await overview(app, staff.headers);
    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe("internal_error");
    expect(lines().find((l) => l.code === "internal_error")?.msg).toBe(line);
  });

  test("a moderator and an admin both read it, and no audit row is written", async ({
    ctx,
    app,
  }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const admin = await staffSession(ctx.client, "admin");
    const owner = await signedInAccount(ctx.client);
    await photoIn(ctx, owner.accountId, "queued", "2026-10-16T06:00:00.000Z");
    await feedbackIn(ctx, owner.accountId, "2026-10-16T07:00:00.000Z");
    const before = await auditRows(ctx);
    const answers = [];
    for (const staff of [moderator, admin]) {
      const response = await overview(app, staff.headers);
      expect(response.status, staff.role).toBe(200);
      answers.push(AdminOverview.parse(await response.json()));
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]?.queues).toEqual([
      { queue: "reports", waiting: 0, oldestSince: null },
      { queue: "photos", waiting: 1, oldestSince: "2026-10-16T06:00:00.000Z" },
      { queue: "feedback", waiting: 1, oldestSince: "2026-10-16T07:00:00.000Z" },
    ]);
    expect(await auditRows(ctx)).toEqual(before);
  });
});

describe("the moderators' guard on GET /admin/overview", () => {
  test("each variant of a missing or dead session is refused with 401 and its own code", async ({
    ctx,
    app,
  }) => {
    const member = await signedInAccount(ctx.client);
    const ended = await staffSession(ctx.client);
    await ctx.client.query("UPDATE admin_session SET revoked_at = now() WHERE id = $1", [
      ended.sessionId,
    ]);
    const demoted = await staffSession(ctx.client);
    await ctx.client.query("DELETE FROM moderator_roles WHERE identity_id = $1", [
      demoted.identityId,
    ]);
    const expired = await staffSession(ctx.client);
    await ctx.client.query(
      "UPDATE admin_session SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [expired.sessionId],
    );
    const before = await auditRows(ctx);
    for (const [what, headers, code] of [
      ["no token", {}, "unauthenticated"],
      ["another scheme", { authorization: `Basic ${"A".repeat(43)}` }, "unauthenticated"],
      ["a malformed token", { authorization: "Bearer not-a-token" }, "unauthenticated"],
      ["an unknown token", { authorization: `Bearer ${"A".repeat(43)}` }, "unauthenticated"],
      ["a product session's token", member.headers, "unauthenticated"],
      ["an ended session", ended.headers, "session_revoked"],
      ["a role taken away", demoted.headers, "session_revoked"],
      ["an expired session", expired.headers, "session_expired"],
    ] as const) {
      const response = await overview(app, headers);
      expect(response.status, what).toBe(401);
      expect(await errorCode(response), what).toBe(code);
    }
    expect(await auditRows(ctx)).toEqual(before);
  });

  test("a researcher is refused with 403 admin_forbidden", async ({ ctx, app }) => {
    const researcher = await staffSession(ctx.client, "researcher");
    const response = await overview(app, researcher.headers);
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("admin_forbidden");
  });
});
