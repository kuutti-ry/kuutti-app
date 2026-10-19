import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ErrorResponse, ReportQueue, ReportQueueQuery } from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { staffOf } from "../lib/admin-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import { MODERATION_RESPONSE_HOURS_KEY } from "./overview-routes.ts";
import { listReports } from "./report-queue.ts";

// The panel's report queue (#311, TD-5): the list a moderator picks a report
// from. Listing writes no audit row, as it shows neither the reporter's words
// nor the conversation; opening one report does (#312).

const errorContent = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});

const listRoute = createRoute({
  method: "get",
  path: "/admin/reports",
  summary: "The reports, for a moderator",
  description:
    "Open reports the oldest first, those about one account together, the group whose oldest waited longest first; or closed ones, the newest decision first. Each with its reason, where it was made, both account ids, the reporter's reports filed and upheld, and the reported account's reports received and sanctions. A report the reading member of staff is a party to is left out, and out of every count. With the API's clock and matching_config moderation_response_hours. Moderators and admins.",
  security: [{ session: [] }],
  request: { query: ReportQueueQuery },
  responses: {
    200: {
      description: "A page of reports.",
      content: { "application/json": { schema: ReportQueue } },
    },
    400: errorContent("Validation failed."),
    401: errorContent("unauthenticated, session_expired or session_revoked."),
    403: errorContent("admin_forbidden: the role does not allow this."),
  },
});

export function reportAdminRoutes(deps: Deps, requireModerator: MiddlewareHandler<AppEnv>) {
  const app = new OpenAPIHono<AppEnv>();
  const now = () => (deps.now ?? (() => new Date()))();
  app.use(listRoute.getRoutingPath(), requireModerator);

  app.openapi(listRoute, async (c) => {
    const staff = staffOf(c);
    const query = c.req.valid("query");
    const [page, responseHours] = await Promise.all([
      listReports(deps.db, staff.identityId, query),
      matchingConfigNumber(deps.db, MODERATION_RESPONSE_HOURS_KEY),
    ]);
    return c.json({ now: now().toISOString(), responseHours, ...page }, 200);
  });

  return app;
}
