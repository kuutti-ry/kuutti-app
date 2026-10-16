import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { Queryable } from "@kuutti/db";
import { ErrorResponse, StaffList } from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import type { AppEnv } from "../lib/env.ts";

// The staff list (#310), admins only: who holds a role, since when, from
// whom, and their last sign-in to the panel, so the access policy can be
// checked against what is true (#192). Reading it writes no audit row.
// Granting and revoking a role stay the maintainer's tool (ADR-006 §5:
// "written by the maintainer, never by a route"), so no route here writes.

const errorContent = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});

/** Every member of staff, oldest grant first, with their latest panel sign-in. */
async function listStaff(db: Queryable): Promise<StaffList> {
  const { rows } = await db.query<{
    identity_id: string;
    role: StaffList["items"][number]["role"];
    granted_at: Date;
    granted_by: string;
    last_sign_in: Date | null;
  }>(
    `SELECT m.identity_id, m.role, m.granted_at, m.granted_by,
       (SELECT max(s.created_at) FROM admin_session s WHERE s.identity_id = m.identity_id) AS last_sign_in
     FROM moderator_roles m ORDER BY m.granted_at, m.identity_id`,
  );
  return {
    items: rows.map((r) => ({
      identityId: r.identity_id,
      role: r.role,
      grantedAt: r.granted_at.toISOString(),
      grantedBy: r.granted_by,
      lastSignInAt: r.last_sign_in?.toISOString() ?? null,
    })),
  };
}

const staffRoute = createRoute({
  method: "get",
  path: "/admin/staff",
  summary: "Who holds a role",
  description:
    "Every member of staff by identity id: the role, when and by whom it was granted, the last sign-in to the panel. Granting and revoking stay the maintainer's tool. Admins only.",
  security: [{ session: [] }],
  responses: {
    200: { description: "The staff.", content: { "application/json": { schema: StaffList } } },
    401: errorContent("unauthenticated, session_expired or session_revoked."),
    403: errorContent("admin_forbidden: the role does not allow this."),
  },
});

export function staffAdminRoutes(deps: Deps, requireAdministrator: MiddlewareHandler<AppEnv>) {
  const app = new OpenAPIHono<AppEnv>();
  app.use(staffRoute.getRoutingPath(), requireAdministrator);
  app.openapi(staffRoute, async (c) => c.json(await listStaff(deps.db), 200));
  return app;
}
