import { ErrorResponse, StaffList } from "@kuutti/schema";
import type { App } from "../app.ts";
import { sweepAdminSessions } from "../identity/index.ts";
import { signedInAccount, staffSession } from "../test/account.ts";
import { describe, expect, type TestContext, test } from "../test/harness.ts";

// The staff list through the app (#310): the list against moderator_roles
// and the latest admin_session, a revoked role gone, the admins' guard in
// each of its variants on both admin read routes (#309's too), and no audit
// row for the read. The rollback after
// each test takes its rows back with everything else.

type Headers = Record<string, string>;

const staffList = (app: App, headers: Headers) => app.request("/admin/staff", { headers });
/** The audit reader, asked bare: the guard test holds both of the admins' read routes to the same variants. */
const audit = (app: App, headers: Headers) => app.request("/admin/audit", { headers });

async function errorCode(response: Response): Promise<string> {
  return ErrorResponse.parse(await response.json()).error.code;
}

async function auditRows(ctx: TestContext) {
  return (await ctx.client.query("SELECT * FROM audit_log ORDER BY at, id")).rows;
}

async function memberIn(
  ctx: TestContext,
  label: string,
  role: "moderator" | "admin" | "researcher",
  grantedAt: string,
  grantedBy: string,
): Promise<string> {
  const { rows } = await ctx.client.query<{ id: string }>(
    "INSERT INTO identity (hetu_hmac) VALUES (encode(sha256(convert_to($1, 'UTF8')), 'hex')) RETURNING id",
    [`kuutti test staff list: ${label}`],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("test identity not written");
  await ctx.client.query(
    "INSERT INTO moderator_roles (identity_id, role, granted_at, granted_by) VALUES ($1, $2, $3, $4)",
    [id, role, grantedAt, grantedBy],
  );
  return id;
}

/** A panel sign-in that started at `createdAt`; revoked and long expired, since a past sign-in is still one. */
async function signInAt(
  ctx: TestContext,
  identityId: string,
  role: string,
  createdAt: string,
): Promise<void> {
  await ctx.client.query(
    `INSERT INTO admin_session (identity_id, role, access_hash, created_at, expires_at, last_used_at, revoked_at)
     VALUES ($1, $2, $3, $4, $4::timestamptz + interval '8 hours', $4, $4::timestamptz + interval '1 hour')`,
    [identityId, role, `test-hash-${identityId}-${createdAt}`, createdAt],
  );
}

/** moderator_roles as the list should show it, with the latest session read on its own. */
async function table(ctx: TestContext) {
  const { rows } = await ctx.client.query<{
    identity_id: string;
    role: string;
    granted_at: Date;
    granted_by: string;
  }>(
    "SELECT identity_id, role, granted_at, granted_by FROM moderator_roles ORDER BY granted_at, identity_id",
  );
  const out = [];
  for (const r of rows) {
    const latest = await ctx.client.query<{ created_at: Date }>(
      "SELECT created_at FROM admin_session WHERE identity_id = $1 ORDER BY created_at DESC LIMIT 1",
      [r.identity_id],
    );
    out.push({
      identityId: r.identity_id,
      role: r.role,
      grantedAt: r.granted_at.toISOString(),
      grantedBy: r.granted_by,
      lastSignInAt: latest.rows[0]?.created_at.toISOString() ?? null,
    });
  }
  return out;
}

async function staff(app: App, headers: Headers): Promise<StaffList> {
  const response = await staffList(app, headers);
  expect(response.status).toBe(200);
  return StaffList.parse(await response.json());
}

describe("GET /admin/staff", () => {
  test("the list matches moderator_roles: role, grant time, grantor and last sign-in, oldest grant first", async ({
    ctx,
  }) => {
    const admin = await staffSession(ctx.client, "admin");
    await ctx.client.query(
      "UPDATE moderator_roles SET granted_at = '2026-09-01T10:00:00.000Z' WHERE identity_id = $1",
      [admin.identityId],
    );
    // Written out of grant order.
    const moderator = await memberIn(ctx, "m", "moderator", "2026-03-01T08:00:00.000Z", "nikolai");
    const researcher = await memberIn(
      ctx,
      "r",
      "researcher",
      "2026-01-15T12:30:00.250Z",
      "nikolai (cli)",
    );
    const second = await memberIn(ctx, "a", "admin", "2026-06-30T21:00:00.000Z", "maintainer");
    await signInAt(ctx, moderator, "moderator", "2026-10-10T07:00:00.000Z");
    const { rows } = await ctx.client.query<{ created_at: Date }>(
      "SELECT created_at FROM admin_session WHERE id = $1",
      [admin.sessionId],
    );
    const readerSignedIn = rows[0]?.created_at.toISOString();

    const list = await staff(ctx.app, admin.headers);
    expect(list.items).toEqual(await table(ctx));
    expect(list.items).toEqual([
      {
        identityId: researcher,
        role: "researcher",
        grantedAt: "2026-01-15T12:30:00.250Z",
        grantedBy: "nikolai (cli)",
        lastSignInAt: null,
      },
      {
        identityId: moderator,
        role: "moderator",
        grantedAt: "2026-03-01T08:00:00.000Z",
        grantedBy: "nikolai",
        lastSignInAt: "2026-10-10T07:00:00.000Z",
      },
      {
        identityId: second,
        role: "admin",
        grantedAt: "2026-06-30T21:00:00.000Z",
        grantedBy: "maintainer",
        lastSignInAt: null,
      },
      {
        identityId: admin.identityId,
        role: "admin",
        grantedAt: "2026-09-01T10:00:00.000Z",
        grantedBy: "test",
        lastSignInAt: readerSignedIn,
      },
    ]);
  });

  test("the last sign-in is the latest session's start, of two, and only the member's own", async ({
    ctx,
  }) => {
    const admin = await staffSession(ctx.client, "admin");
    const twice = await memberIn(ctx, "twice", "moderator", "2026-02-01T00:00:00.000Z", "nikolai");
    const never = await memberIn(ctx, "never", "researcher", "2026-02-02T00:00:00.000Z", "nikolai");
    const once = await memberIn(ctx, "once", "moderator", "2026-02-03T00:00:00.000Z", "nikolai");
    // The later one first, so the answer is not the row written last.
    await signInAt(ctx, twice, "moderator", "2026-10-14T07:30:00.000Z");
    await signInAt(ctx, twice, "moderator", "2026-10-01T08:00:00.000Z");
    // Somebody else's later sign-in is not theirs.
    await signInAt(ctx, once, "moderator", "2026-10-15T06:00:00.000Z");
    const list = await staff(ctx.app, admin.headers);
    const last = (id: string) => list.items.find((m) => m.identityId === id)?.lastSignInAt;
    expect(last(twice)).toBe("2026-10-14T07:30:00.000Z");
    expect(last(never)).toBeNull();
    expect(last(once)).toBe("2026-10-15T06:00:00.000Z");
  });

  test("the last sign-in outlives the night's sweep of ended sessions (#310, ADR-006)", async ({
    ctx,
  }) => {
    const admin = await staffSession(ctx.client, "admin");
    const twice = await memberIn(ctx, "twice", "moderator", "2026-02-01T00:00:00.000Z", "nikolai");
    // Both sessions ended long ago: the sweep keeps the newer, and the list still says it.
    await signInAt(ctx, twice, "moderator", "2026-10-01T08:00:00.000Z");
    await signInAt(ctx, twice, "moderator", "2026-10-14T07:30:00.000Z");
    await sweepAdminSessions({ db: ctx.client, now: () => new Date("2026-10-16T02:00:00.000Z") });
    const list = await staff(ctx.app, admin.headers);
    expect(list.items.find((m) => m.identityId === twice)?.lastSignInAt).toBe(
      "2026-10-14T07:30:00.000Z",
    );
    const { rows } = await ctx.client.query(
      "SELECT created_at FROM admin_session WHERE identity_id = $1",
      [twice],
    );
    expect(rows).toHaveLength(1);
  });

  test("a revoked role is gone from the list, its sessions and identity notwithstanding", async ({
    ctx,
  }) => {
    const admin = await staffSession(ctx.client, "admin");
    const kept = await memberIn(ctx, "kept", "moderator", "2026-04-01T00:00:00.000Z", "nikolai");
    const gone = await memberIn(ctx, "gone", "moderator", "2026-04-02T00:00:00.000Z", "nikolai");
    await signInAt(ctx, gone, "moderator", "2026-10-12T09:00:00.000Z");
    const ids = async () => (await staff(ctx.app, admin.headers)).items.map((m) => m.identityId);
    expect(await ids()).toContain(gone);
    // What the maintainer's tool does to revoke (packages/db/src/cli/moderator.ts).
    await ctx.client.query("DELETE FROM moderator_roles WHERE identity_id = $1", [gone]);
    const after = await ids();
    expect(after).not.toContain(gone);
    expect(after).toContain(kept);
    expect((await staff(ctx.app, admin.headers)).items).toEqual(await table(ctx));
  });

  test("members granted at the same instant are listed by identity id", async ({ ctx }) => {
    const admin = await staffSession(ctx.client, "admin");
    const same = "2026-05-05T05:05:05.000Z";
    const members = [
      await memberIn(ctx, "x", "moderator", same, "nikolai"),
      await memberIn(ctx, "y", "researcher", same, "nikolai"),
      await memberIn(ctx, "z", "admin", same, "nikolai"),
    ];
    const listed = (await staff(ctx.app, admin.headers)).items
      .filter((m) => m.grantedAt === same)
      .map((m) => m.identityId);
    expect(listed).toEqual([...members].sort());
  });

  test("reading the list writes no audit row", async ({ ctx }) => {
    const admin = await staffSession(ctx.client, "admin");
    await memberIn(ctx, "m", "moderator", "2026-03-01T08:00:00.000Z", "nikolai");
    const before = await auditRows(ctx);
    await staff(ctx.app, admin.headers);
    expect(await auditRows(ctx)).toEqual(before);
  });
});

// The admins' guard on both routes, in each variant the code tells apart.
describe.for([
  ["GET /admin/audit", (app: App, headers: Headers) => audit(app, headers)],
  ["GET /admin/staff", staffList],
] as const)("the admins' guard on %s", ([, call]) => {
  test("each variant of a missing or dead session is refused with 401 and its own code", async ({
    ctx,
  }) => {
    const member = await signedInAccount(ctx.client);
    const ended = await staffSession(ctx.client, "admin");
    await ctx.client.query("UPDATE admin_session SET revoked_at = now() WHERE id = $1", [
      ended.sessionId,
    ]);
    const demoted = await staffSession(ctx.client, "admin");
    await ctx.client.query("DELETE FROM moderator_roles WHERE identity_id = $1", [
      demoted.identityId,
    ]);
    const barred = await staffSession(ctx.client, "admin");
    await ctx.client.query("UPDATE identity SET standing = 'banned' WHERE id = $1", [
      barred.identityId,
    ]);
    const expired = await staffSession(ctx.client, "admin");
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
      ["a banned identity", barred.headers, "session_revoked"],
      ["an expired session", expired.headers, "session_expired"],
    ] as const) {
      const response = await call(ctx.app, headers);
      expect(response.status, what).toBe(401);
      expect(await errorCode(response), what).toBe(code);
    }
    expect(await auditRows(ctx)).toEqual(before);
  });

  test("a moderator and a researcher are refused with 403 admin_forbidden; an admin is answered", async ({
    ctx,
  }) => {
    for (const role of ["moderator", "researcher"] as const) {
      const refused = await call(ctx.app, (await staffSession(ctx.client, role)).headers);
      expect(refused.status, role).toBe(403);
      expect(await errorCode(refused), role).toBe("admin_forbidden");
    }
    const admin = await staffSession(ctx.client, "admin");
    expect((await call(ctx.app, admin.headers)).status).toBe(200);
  });
});
