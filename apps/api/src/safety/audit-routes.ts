import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { type Queryable, transaction } from "@kuutti/db";
import {
  type AdminAuditRow,
  AUDIT_PAGE_SIZE,
  type AuditEntry,
  AuditPage,
  AuditQuery,
  ErrorResponse,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { staffOf } from "../lib/admin-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { AppError } from "../lib/errors.ts";
import { type AuditEntry as AuditRow, recordAudit } from "./audit.ts";

// The audit log's reader (#309), admins only: who did or saw what, narrowed
// by who, what, whom and when, page by page and never all at once
// (rules/admin.md: never a bulk export). A read narrowed to one subject is a
// look at that person's record, the kind and reason of every sanction and
// rejection included, so it writes `audit.read` about that subject first, as
// the person's page writes account.view (#306). A read not narrowed to a
// subject writes nothing: it is the oversight of staff, and a row per page
// would say nothing TD-5 asks for.

const errorContent = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});
const staffErrors = {
  401: errorContent("unauthenticated, session_expired or session_revoked."),
  403: errorContent("admin_forbidden: the role does not allow this."),
};

/**
 * The keyset cursor: the last row's time and id, opaque to the panel. The
 * time is the database's own to the microsecond: now() has microseconds and
 * a Date has not, so a cursor of milliseconds would skip the rows that share
 * one with it.
 */
function cursorOf(row: { at_exact: string; id: string }): string {
  return Buffer.from(JSON.stringify([row.at_exact, row.id])).toString("base64url");
}

const EXACT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(\d{3})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A time the database takes as it is: the shape a cursor carries, a day the calendar has, from 1970 on. */
function exactInstant(at: string): boolean {
  if (!EXACT.test(at)) return false;
  const ms = Date.parse(at);
  return ms >= 0 && new Date(ms).toISOString().slice(0, 19) === at.slice(0, 19);
}

function fromCursor(cursor: string): { at: string; id: string } {
  try {
    const [at, id, ...rest] = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown[];
    if (rest.length === 0 && typeof at === "string" && typeof id === "string") {
      if (exactInstant(at) && UUID.test(id)) return { at, id };
    }
  } catch {
    // Fall through to the refusal below.
  }
  throw new AppError(400, "cursor_invalid", "Not a cursor this route gave");
}

/** One page, newest first; the next older page's cursor when there is one. */
async function readAudit(db: Queryable, query: AuditQuery): Promise<AuditPage> {
  const before = query.before ? fromCursor(query.before) : null;
  const { rows } = await db.query<{
    id: string;
    at: Date;
    at_exact: string;
    actor_identity_id: string;
    actor_role: AuditEntry["actorRole"];
    action: string;
    subject_type: string;
    subject_id: string;
    account_id: string | null;
    detail: AdminAuditRow["detail"];
  }>(
    `SELECT a.id, a.at, to_char(a.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at_exact,
       a.actor_identity_id, m.role AS actor_role, a.action, a.subject_type, a.subject_id,
       CASE a.subject_type WHEN 'account' THEN a.subject_id WHEN 'photo' THEN p.account_id END AS account_id,
       a.detail
     FROM audit_log a
     LEFT JOIN moderator_roles m ON m.identity_id = a.actor_identity_id
     LEFT JOIN photo p ON a.subject_type = 'photo' AND p.id = a.subject_id
     WHERE ($1::uuid IS NULL OR a.actor_identity_id = $1)
       AND ($2::text IS NULL OR a.action = $2)
       AND ($3::text IS NULL OR a.subject_type = $3)
       AND ($4::uuid IS NULL OR a.subject_id = $4)
       AND ($5::timestamptz IS NULL OR a.at >= $5)
       AND ($6::timestamptz IS NULL OR a.at < $6)
       AND ($7::timestamptz IS NULL OR (a.at, a.id) < ($7, $8::uuid))
     ORDER BY a.at DESC, a.id DESC LIMIT $9`,
    [
      query.actor ?? null,
      query.action ?? null,
      query.subjectType ?? null,
      query.subjectId ?? null,
      query.from ?? null,
      query.to ?? null,
      before?.at ?? null,
      before?.id ?? null,
      AUDIT_PAGE_SIZE + 1,
    ],
  );
  const page = rows.slice(0, AUDIT_PAGE_SIZE);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      at: r.at.toISOString(),
      actorIdentityId: r.actor_identity_id,
      actorRole: r.actor_role,
      action: r.action,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      accountId: r.account_id,
      detail: r.detail ?? null,
    })),
    next: rows.length > AUDIT_PAGE_SIZE && last ? cursorOf(last) : null,
  };
}

const auditRoute = createRoute({
  method: "get",
  path: "/admin/audit",
  summary: "The audit log, a page at a time",
  description: `Who did or saw what, newest first, ${AUDIT_PAGE_SIZE} rows a page; narrowed by actor, action, subject type and id, and a time window; \`before\` is the \`next\` of the page before. Never more than a page. Admins only; a read narrowed to a subject id writes audit.read about it first, any other read writes nothing.`,
  security: [{ session: [] }],
  request: { query: AuditQuery },
  responses: {
    200: { description: "One page.", content: { "application/json": { schema: AuditPage } } },
    400: errorContent("Validation failed, or cursor_invalid: a cursor this route did not give."),
    ...staffErrors,
  },
});

/** The subject types an audit row names; a read narrowed by another, or by none, names "any". */
const SUBJECT_TYPES = new Set(["photo", "feedback", "account", "config", "report"]);

export function auditAdminRoutes(deps: Deps, requireAdministrator: MiddlewareHandler<AppEnv>) {
  const app = new OpenAPIHono<AppEnv>();
  app.use(auditRoute.getRoutingPath(), requireAdministrator);
  app.openapi(auditRoute, async (c) => {
    const query = c.req.valid("query");
    const { subjectId } = query;
    if (!subjectId) return c.json(await readAudit(deps.db, query), 200);
    const staff = staffOf(c);
    const page = await transaction(deps.db, async (tx) => {
      await recordAudit(tx, {
        actorIdentityId: staff.identityId,
        action: "audit.read",
        subjectType: SUBJECT_TYPES.has(query.subjectType ?? "")
          ? (query.subjectType as AuditRow["subjectType"])
          : "any",
        subjectId,
      });
      return readAudit(tx, query);
    });
    return c.json(page, 200);
  });
  return app;
}
