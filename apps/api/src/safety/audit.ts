import type { Queryable } from "@kuutti/db";

// The audit log (TD-5, security checklist "Moderator actions, disclosure
// requests, and photo views by staff write to the immutable audit table").
// One row per thing a member of staff did or saw, keyed by their identity
// (never an account); the table refuses UPDATE and DELETE by trigger
// (migration 0006), so a row written here is a row kept for five years
// (rules/db.md). `detail` is a small closed structure, never text a person
// typed.

const AUDIT_ACTIONS = [
  "photo.view",
  "photo.approve",
  "photo.reject",
  "feedback.handle",
  "sanction.apply",
  "sanction.lift",
  "sanction.review",
] as const;
type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditEntry = {
  actorIdentityId: string;
  action: AuditAction;
  subjectType: "photo" | "feedback" | "account";
  subjectId: string;
  detail?: Record<string, string | number | boolean | null>;
};

/**
 * Whether the role boundary of ADR-006 is in place: audit_log and its trigger
 * function owned by another role, and this connection without UPDATE, DELETE
 * or TRUNCATE. Logged at boot; a deployed box without it is a warning the
 * maintainer answers with infra/scripts/db-audit-owner.sh.
 */
export async function auditBoundary(db: Queryable): Promise<{
  connectedAs: string;
  tableOwner: string | null;
  functionOwner: string | null;
  schemaOwner: string | null;
  enforced: boolean;
}> {
  // Everything schema-qualified and by oid: a same-named table or function in
  // another schema (which the application role could create) must neither
  // fool the check nor make it throw; a database without the table (the
  // no-journal state) answers rather than crashes the boot.
  const { rows } = await db.query<{
    me: string;
    table_owner: string | null;
    function_owner: string | null;
    can_rewrite: boolean;
    member_of_owner: boolean | null;
    resolves_to_public: boolean | null;
    schema_owner: string | null;
  }>(
    `SELECT current_user AS me,
       (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = to_regclass('public.audit_log')) AS table_owner,
       (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = to_regprocedure('public.audit_log_immutable()')) AS function_owner,
       (to_regclass('public.audit_log') IS NOT NULL AND (
          has_table_privilege('public.audit_log', 'UPDATE') OR has_table_privilege('public.audit_log', 'DELETE')
          OR has_table_privilege('public.audit_log', 'TRUNCATE'))) AS can_rewrite,
       (SELECT pg_has_role(current_user, relowner, 'MEMBER') FROM pg_class WHERE oid = to_regclass('public.audit_log')) AS member_of_owner,
       (to_regclass('audit_log') = to_regclass('public.audit_log')) AS resolves_to_public,
       (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public') AS schema_owner`,
  );
  const r = rows[0];
  if (!r) {
    return {
      connectedAs: "?",
      tableOwner: null,
      functionOwner: null,
      schemaOwner: null,
      enforced: false,
    };
  }
  return {
    connectedAs: r.me,
    tableOwner: r.table_owner,
    functionOwner: r.function_owner,
    schemaOwner: r.schema_owner,
    enforced:
      r.table_owner !== null &&
      r.table_owner !== r.me &&
      r.function_owner !== null &&
      r.function_owner !== r.me &&
      !r.can_rewrite &&
      r.member_of_owner === false &&
      r.resolves_to_public === true &&
      r.schema_owner !== null &&
      r.schema_owner !== r.me &&
      r.schema_owner !== "pg_database_owner",
  };
}

/** Writes before the thing happens: a view whose audit row failed is a view that does not happen. */
export async function recordAudit(db: Queryable, entry: AuditEntry): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.audit_log (actor_identity_id, action, subject_type, subject_id, detail)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      entry.actorIdentityId,
      entry.action,
      entry.subjectType,
      entry.subjectId,
      entry.detail ? JSON.stringify(entry.detail) : null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("audit_log insert returned no row");
  return id;
}
