import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { transaction } from "@kuutti/db";
import { AdminAccount, AdminAccountParams, ErrorResponse } from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { staffOf } from "../lib/admin-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { AppError } from "../lib/errors.ts";
import { accountPage } from "./accounts.ts";
import { recordAudit } from "./audit.ts";

// A person's page in the panel (#306): one account by its id, never a search
// (rules/admin.md: never a bulk export; TD-6). Opening it writes account.view
// before the page is read: a look whose audit row failed is a look that does
// not happen (audit.ts). Moderators and admins.

const errorContent = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});

const pageRoute = createRoute({
  method: "get",
  path: "/admin/accounts/{id}",
  summary: "A person's page",
  description:
    "One account by its id: its raw state and the identity's standing, the profile as the card shows it, the photos (the pictures by GET /admin/photos/{id}/card), the feedback the person sent, and the audit rows about them. Never the hash, the broker's ids, the research id or the e-mail. An erased account answers its deletion date and nothing else. Every look is an audit row.",
  security: [{ session: [] }],
  request: { params: AdminAccountParams },
  responses: {
    200: { description: "The page.", content: { "application/json": { schema: AdminAccount } } },
    400: errorContent("Validation failed."),
    401: errorContent("unauthenticated, session_expired or session_revoked."),
    403: errorContent("admin_forbidden: the role does not allow this."),
    404: errorContent("No such account."),
  },
});

export function accountAdminRoutes(deps: Deps, requireModerator: MiddlewareHandler<AppEnv>) {
  const app = new OpenAPIHono<AppEnv>();
  const now = () => (deps.now ?? (() => new Date()))();
  app.use(pageRoute.getRoutingPath(), requireModerator);

  app.openapi(pageRoute, async (c) => {
    const staff = staffOf(c);
    const { id } = c.req.valid("param");
    const page = await transaction(deps.db, async (tx) => {
      const exists = await tx.query("SELECT 1 FROM account WHERE id = $1", [id]);
      if (exists.rowCount !== 1) throw new AppError(404, "not_found", "No such account");
      await recordAudit(tx, {
        actorIdentityId: staff.identityId,
        action: "account.view",
        subjectType: "account",
        subjectId: id,
      });
      return accountPage(tx, id, now());
    });
    if (!page) throw new AppError(404, "not_found", "No such account");
    deps.logger.info({ staffIdentityId: staff.identityId, accountId: id }, "account viewed");
    return c.json(page, 200);
  });

  return app;
}
