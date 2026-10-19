import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { AdminOverview, ErrorResponse } from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { staffOf } from "../lib/admin-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import { queueSummary } from "../media/index.ts";
import { AUTO_SHADOW_BAN_REVIEW_HOURS_KEY, automaticBanSummary } from "./automatic.ts";
import { feedbackSummary } from "./feedback.ts";
import { reportSummary } from "./report-queue.ts";

// The panel's front page (#303): every queue's count and the age of its
// oldest, against the response time the association promises (#299). Counts
// of queues, nothing about a person, so no audit row. The API's clock comes
// with the answer, so the panel measures ages by it and not by the browser's.
// The reports' count leaves out those the reader is a party to, as their
// queue does (#311, ADR-030 §6).

/** matching_config: the hours the association promises to answer within (#299). */
export const MODERATION_RESPONSE_HOURS_KEY = "moderation_response_hours";

const errorContent = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});

const overviewRoute = createRoute({
  method: "get",
  path: "/admin/overview",
  summary: "What waits for the moderators",
  description:
    "Per queue (reports not decided that the reader is no party to, the automatic shadow bans nobody has confirmed or reversed but the reader's own, photos waiting for a person, feedback not handled), how many wait and since when the oldest; the API's clock; matching_config moderation_response_hours, past which the oldest is late, and auto_shadow_ban_review_hours, the automatic bans' own. Moderators and admins.",
  security: [{ session: [] }],
  responses: {
    200: {
      description: "The queues.",
      content: { "application/json": { schema: AdminOverview } },
    },
    401: errorContent("unauthenticated, session_expired or session_revoked."),
    403: errorContent("admin_forbidden: the role does not allow this."),
  },
});

export function overviewAdminRoutes(deps: Deps, requireModerator: MiddlewareHandler<AppEnv>) {
  const app = new OpenAPIHono<AppEnv>();
  const now = () => (deps.now ?? (() => new Date()))();
  app.use(overviewRoute.getRoutingPath(), requireModerator);

  app.openapi(overviewRoute, async (c) => {
    const staff = staffOf(c);
    const [reports, automatic, photos, feedback, responseHours, reviewHours] = await Promise.all([
      reportSummary(deps.db, staff.identityId),
      automaticBanSummary(deps.db, staff.identityId),
      queueSummary(deps.db),
      feedbackSummary(deps.db),
      matchingConfigNumber(deps.db, MODERATION_RESPONSE_HOURS_KEY),
      matchingConfigNumber(deps.db, AUTO_SHADOW_BAN_REVIEW_HOURS_KEY),
    ]);
    const queue = (
      name: "reports" | "automatic_bans" | "photos" | "feedback",
      s: typeof photos,
    ) => ({
      queue: name,
      waiting: s.waiting,
      oldestSince: s.oldestSince?.toISOString() ?? null,
    });
    return c.json(
      {
        now: now().toISOString(),
        responseHours,
        reviewHours,
        queues: [
          queue("reports", reports),
          queue("automatic_bans", automatic),
          queue("photos", photos),
          queue("feedback", feedback),
        ],
      },
      200,
    );
  });

  return app;
}
