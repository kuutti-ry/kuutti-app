import { randomBytes } from "node:crypto";
import { describe, expect } from "vitest";
import { signedInAccount, staffSession } from "../test/account.ts";
import { type TestContext, test } from "../test/harness.ts";
import { auditBoundary, recordAudit } from "./audit.ts";

// features/safety/audit.feature: the row says who, what, subject, when; and
// the trigger of migration 0006 keeps it that way against the application role,
// which is the role these tests run as.

describe("audit log", () => {
  test("An audit row is written with who, what, subject and when", async ({ ctx }) => {
    const staff = await staffSession(ctx.client);
    const owner = await signedInAccount(ctx.client);
    const photo = await ctx.client.query<{ id: string }>(
      `INSERT INTO photo (account_id, key, blurhash, width, height, position)
       VALUES ($1, 'k', 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 10, 10, 0) RETURNING id`,
      [owner.accountId],
    );
    const photoId = photo.rows[0]?.id ?? "";
    const id = await recordAudit(ctx.client, {
      actorIdentityId: staff.identityId,
      action: "photo.view",
      subjectType: "photo",
      subjectId: photoId,
      detail: { variant: "card" },
    });
    const row = await ctx.client.query(
      "SELECT actor_identity_id, action, subject_type, subject_id, detail, at FROM audit_log WHERE id = $1",
      [id],
    );
    expect(row.rows[0]).toMatchObject({
      actor_identity_id: staff.identityId,
      action: "photo.view",
      subject_type: "photo",
      subject_id: photoId,
      detail: { variant: "card" },
    });
    expect(row.rows[0]?.at).toBeInstanceOf(Date);
  });

  test("An audit row cannot be updated or deleted", async ({ ctx }) => {
    const staff = await staffSession(ctx.client);
    const id = await recordAudit(ctx.client, {
      actorIdentityId: staff.identityId,
      action: "photo.approve",
      subjectType: "photo",
      subjectId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    });
    // A failed statement aborts the surrounding transaction in Postgres, so
    // each attempt runs inside its own savepoint and the transaction of the test survives.
    await ctx.client.query("SAVEPOINT attempt");
    await expect(
      ctx.client.query("UPDATE audit_log SET action = 'photo.reject' WHERE id = $1", [id]),
    ).rejects.toThrow(/append-only: UPDATE refused/);
    await ctx.client.query("ROLLBACK TO SAVEPOINT attempt");
    await expect(ctx.client.query("DELETE FROM audit_log WHERE id = $1", [id])).rejects.toThrow(
      /append-only: DELETE refused/,
    );
    await ctx.client.query("ROLLBACK TO SAVEPOINT attempt");
    await expect(ctx.client.query("TRUNCATE audit_log")).rejects.toThrow(
      /append-only: TRUNCATE refused/,
    );
    await ctx.client.query("ROLLBACK TO SAVEPOINT attempt");
    const row = await ctx.client.query("SELECT action FROM audit_log WHERE id = $1", [id]);
    expect(row.rows[0]?.action).toBe("photo.approve");
  });
});

// The boot check of ADR-006 (index.ts logs it, and warns on a deployed box
// without it). The boundary is staged inside the test's transaction: roles,
// owners and grants are transactional in Postgres, so the rollback takes all
// of it back. Staging needs a superuser (the compose Postgres and CI's
// service container); elsewhere these tests are skipped, not passed.

type Staged = { app: string; audit: string; probe: string };

async function isSuperuser(ctx: TestContext): Promise<boolean> {
  const { rows } = await ctx.client.query<{ rolsuper: boolean }>(
    "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
  );
  return rows[0]?.rolsuper === true;
}

/**
 * The shape db-audit-owner.sql leaves behind: audit_log, its trigger function
 * and the public schema owned by an audit role the API never connects as; the
 * application role with SELECT and INSERT on the table and USAGE on the schema.
 */
async function stageBoundary(ctx: TestContext): Promise<Staged> {
  const tag = randomBytes(4).toString("hex");
  const staged = { app: `probe_app_${tag}`, audit: `probe_audit_${tag}`, probe: `probe_${tag}` };
  for (const sql of [
    `CREATE ROLE ${staged.audit} NOLOGIN`,
    `CREATE ROLE ${staged.app} NOLOGIN`,
    `ALTER TABLE public.audit_log OWNER TO ${staged.audit}`,
    `ALTER FUNCTION public.audit_log_immutable() OWNER TO ${staged.audit}`,
    `ALTER SCHEMA public OWNER TO ${staged.audit}`,
    `GRANT USAGE ON SCHEMA public TO ${staged.app}`,
    `GRANT SELECT, INSERT ON public.audit_log TO ${staged.app}`,
  ]) {
    await ctx.client.query(sql);
  }
  return staged;
}

const connectAs = (ctx: TestContext, role: string) =>
  ctx.client.query(`SET LOCAL ROLE ${role}`).then(() => undefined);

describe("the audit boundary at boot", () => {
  test("on the development database the connecting role owns the table, and the check says it is not enforced", async ({
    ctx,
  }) => {
    const me = (await ctx.client.query<{ me: string }>("SELECT current_user AS me")).rows[0]?.me;
    const boundary = await auditBoundary(ctx.client);
    expect(boundary).toMatchObject({ connectedAs: me, tableOwner: me, functionOwner: me });
    expect(boundary.enforced).toBe(false);
  });

  test("with table, trigger function and schema owned by another role and only INSERT and SELECT granted, it is enforced", async ({
    ctx,
    skip,
  }) => {
    if (!(await isSuperuser(ctx))) skip();
    const staged = await stageBoundary(ctx);
    await connectAs(ctx, staged.app);
    expect(await auditBoundary(ctx.client)).toEqual({
      connectedAs: staged.app,
      tableOwner: staged.audit,
      functionOwner: staged.audit,
      schemaOwner: staged.audit,
      enforced: true,
    });
  });

  test.for([
    [
      "the application role may still update the table",
      (s: Staged) => [`GRANT UPDATE ON public.audit_log TO ${s.app}`],
    ],
    [
      "the application role may still delete from the table",
      (s: Staged) => [`GRANT DELETE ON public.audit_log TO ${s.app}`],
    ],
    [
      "the application role may still truncate the table",
      (s: Staged) => [`GRANT TRUNCATE ON public.audit_log TO ${s.app}`],
    ],
    [
      "the application role is a member of the owner",
      (s: Staged) => [`GRANT ${s.audit} TO ${s.app}`],
    ],
    [
      "the application role still owns the trigger function",
      (s: Staged) => [`ALTER FUNCTION public.audit_log_immutable() OWNER TO ${s.app}`],
    ],
    [
      "the application role still owns the table",
      (s: Staged) => [`ALTER TABLE public.audit_log OWNER TO ${s.app}`],
    ],
    [
      "the application role owns the schema",
      (s: Staged) => [`ALTER SCHEMA public OWNER TO ${s.app}`],
    ],
    [
      "the schema still belongs to the database's owner",
      () => ["ALTER SCHEMA public OWNER TO pg_database_owner"],
    ],
    [
      "a same-named table earlier on the search path shadows the real one",
      (s: Staged) => [
        `CREATE SCHEMA ${s.probe}`,
        `CREATE TABLE ${s.probe}.audit_log (id int)`,
        `GRANT USAGE ON SCHEMA ${s.probe} TO ${s.app}`,
        `SET LOCAL search_path = ${s.probe}, public`,
      ],
    ],
  ] as const)("not enforced when %s", async ([, gap], { ctx, skip }) => {
    if (!(await isSuperuser(ctx))) skip();
    const staged = await stageBoundary(ctx);
    for (const sql of gap(staged)) await ctx.client.query(sql);
    await connectAs(ctx, staged.app);
    const boundary = await auditBoundary(ctx.client);
    expect(boundary.connectedAs).toBe(staged.app);
    expect(boundary.enforced).toBe(false);
  });

  test("a database without the audit table answers with no owners rather than failing the boot", async ({
    ctx,
    skip,
  }) => {
    if (!(await isSuperuser(ctx))) skip();
    const staged = await stageBoundary(ctx);
    await ctx.client.query(`ALTER TABLE public.audit_log RENAME TO audit_log_${staged.probe}`);
    await ctx.client.query(`ALTER FUNCTION public.audit_log_immutable() RENAME TO ${staged.probe}`);
    await connectAs(ctx, staged.app);
    expect(await auditBoundary(ctx.client)).toEqual({
      connectedAs: staged.app,
      tableOwner: null,
      functionOwner: null,
      schemaOwner: staged.audit,
      enforced: false,
    });
  });
});
