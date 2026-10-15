import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { transaction } from "@kuutti/db";
import {
  ErrorResponse,
  FeedbackHandledResponse,
  FeedbackList,
  FeedbackListQuery,
  FeedbackParams,
  FeedbackRequest,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { staffOf } from "../lib/admin-middleware.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { AppError } from "../lib/errors.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import { dayWindow, secondsUntil } from "../media/index.ts";
import { track } from "../research/index.ts";
import { recordAudit } from "./audit.ts";
import {
  FEEDBACK_PER_DAY_KEY,
  findFeedback,
  listUnhandledFeedback,
  markFeedbackHandled,
  recordFeedback,
} from "./feedback.ts";

// Feedback from inside the app (#171, ADR-023): a person sends a kind and a
// few lines; the moderators read them in the panel and mark them handled,
// which is an audit_log row. The text goes into no log line and no research
// event (rule 5): the event carries the kind alone.

const errorContent = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const bearer = { security: [{ session: [] }] };
const unauthenticated = errorContent("unauthenticated, session_expired or session_revoked.");
const staffErrors = {
  401: unauthenticated,
  403: errorContent("admin_forbidden: the role does not allow this."),
};

const sendRoute = createRoute({
  method: "post",
  path: "/feedback",
  summary: "Send feedback to the moderators",
  description:
    "A kind (bug, idea, complaint, praise) and a few lines, with the app's version, the platform and the language the app read. Stored for the moderators' panel; the text reaches no log line and no research event. At most matching_config feedback_per_day a day per account, the Finnish calendar day.",
  ...bearer,
  request: { body: { required: true, ...json(FeedbackRequest) } },
  responses: {
    204: { description: "Stored." },
    400: errorContent(
      "Validation failed: an unknown kind, an empty or too long text, an unknown platform.",
    ),
    401: unauthenticated,
    404: errorContent(
      "No live account: erased between the session guard and the record (not_found).",
    ),
    429: errorContent(
      "feedback_budget_exceeded: the day's feedback is sent; Retry-After is the wait until the day rolls.",
    ),
  },
});

export function feedbackRoutes(deps: Deps, guard: MiddlewareHandler<AppEnv>) {
  const app = new OpenAPIHono<AppEnv>();
  const now = () => (deps.now ?? (() => new Date()))();
  // On the routing path itself, which app.test.ts holds every guarded route to.
  app.use(sendRoute.getRoutingPath(), guard);

  app.openapi(sendRoute, async (c) => {
    const { accountId } = callerOf(c);
    const body = c.req.valid("json");
    const at = now();
    const day = dayWindow(at);
    const limit = await matchingConfigNumber(deps.db, FEEDBACK_PER_DAY_KEY);
    const record = await recordFeedback(deps.db, {
      accountId,
      ...body,
      at,
      since: day.start,
      limit,
    });
    if (!record.live) throw new AppError(404, "not_found", "No live account");
    if (!record.id) {
      const retryAfterSeconds = secondsUntil(day.end, at);
      deps.logger.warn(
        { accountId, used: record.used, limit, retryAfterSeconds, reason: "budget" },
        "feedback refused",
      );
      c.header("Retry-After", String(retryAfterSeconds));
      throw new AppError(429, "feedback_budget_exceeded", "The day's feedback is sent", {
        retryAfterSeconds,
      });
    }
    // The kind and the build, never the words (rules/api.md).
    deps.logger.info(
      {
        accountId,
        feedbackId: record.id,
        kind: body.kind,
        appVersion: body.appVersion,
        platform: body.platform,
        locale: body.locale,
      },
      "feedback sent",
    );
    // Research (#171): the kind alone; nothing without the research consent, which track() checks.
    await track({ db: deps.db, logger: deps.logger, now: () => at }, accountId, "feedback_sent", {
      kind: body.kind,
    });
    return c.body(null, 204);
  });

  return app;
}

const listRoute = createRoute({
  method: "get",
  path: "/admin/feedback",
  summary: "Feedback waiting for a moderator",
  description:
    "The unhandled rows: a bug first and praise last, the oldest first within a kind, with the app's version, the platform and the language the app read, and the sender's account id.",
  ...bearer,
  request: { query: FeedbackListQuery },
  responses: {
    200: { description: "What waits.", ...json(FeedbackList) },
    400: errorContent("Validation failed."),
    ...staffErrors,
  },
});

const handledRoute = createRoute({
  method: "post",
  path: "/admin/feedback/{id}/handled",
  summary: "Mark feedback as handled",
  description: "A moderator read it. Once; written to audit_log with the kind.",
  ...bearer,
  request: { params: FeedbackParams },
  responses: {
    200: { description: "When it was marked.", ...json(FeedbackHandledResponse) },
    400: errorContent("Validation failed."),
    ...staffErrors,
    404: errorContent("No such feedback."),
    409: errorContent("feedback_handled: already marked."),
  },
});

export function feedbackAdminRoutes(deps: Deps, requireModerator: MiddlewareHandler<AppEnv>) {
  const app = new OpenAPIHono<AppEnv>();
  const now = () => (deps.now ?? (() => new Date()))();
  for (const route of [listRoute, handledRoute]) app.use(route.getRoutingPath(), requireModerator);

  app.openapi(listRoute, async (c) => {
    const { limit } = c.req.valid("query");
    return c.json(await listUnhandledFeedback(deps.db, limit), 200);
  });

  app.openapi(handledRoute, async (c) => {
    const staff = staffOf(c);
    const { id } = c.req.valid("param");
    const item = await findFeedback(deps.db, id);
    if (!item) throw new AppError(404, "not_found", "No such feedback");
    const handled = () => new AppError(409, "feedback_handled", "Already marked as handled");
    if (item.handledAt) throw handled();
    // The audit row and the mark are one unit: the update is keyed on the
    // unhandled state, so of two moderators marking at once exactly one
    // writes, and the other's audit row is rolled back with the refusal.
    const handledAt = await transaction(deps.db, async (tx) => {
      await recordAudit(tx, {
        actorIdentityId: staff.identityId,
        action: "feedback.handle",
        subjectType: "feedback",
        subjectId: id,
        detail: { kind: item.kind },
      });
      const at = await markFeedbackHandled(tx, { id, identityId: staff.identityId, at: now() });
      if (!at) throw handled();
      return at;
    });
    deps.logger.info(
      { staffIdentityId: staff.identityId, feedbackId: id, kind: item.kind },
      "feedback handled",
    );
    return c.json({ id, handledAt: handledAt.toISOString() }, 200);
  });

  return app;
}
