import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  ErrorResponse,
  NoticeParams,
  Notices,
  NotificationChoices,
  NotificationKindParams,
  PutNotificationChoice,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { choicesOf, noticesOf, readNotice, setChoice } from "./notifications.ts";

// The notification choices and the notices in the app (#176, ADR-032),
// behind the session guard, each statement naming the caller's account
// (rule 6). Nothing here sends anything.

const errorContent = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const bearer = { security: [{ session: [] }] };
const unauthenticated = errorContent("unauthenticated, session_expired or session_revoked.");

const choicesRoute = createRoute({
  method: "get",
  path: "/account/notifications",
  summary: "What the caller may be notified of",
  description:
    "Every kind (a new round, a message, a match, a moderator's decision), in that order, each on unless the person switched it off. The senders read it when they exist (#102 the message).",
  ...bearer,
  responses: {
    200: { description: "Every kind and whether it is on.", ...json(NotificationChoices) },
    401: unauthenticated,
  },
});

const setChoiceRoute = createRoute({
  method: "put",
  path: "/account/notifications/{kind}",
  summary: "Switch one kind of notification on or off",
  ...bearer,
  request: {
    params: NotificationKindParams,
    body: { required: true, ...json(PutNotificationChoice) },
  },
  responses: {
    200: { description: "Every kind as it now stands.", ...json(NotificationChoices) },
    400: errorContent("validation_failed: an unknown kind, enabled not a boolean, an unknown key."),
    401: unauthenticated,
    404: errorContent("not_found: the account was erased while the request was on its way."),
  },
});

const noticesRoute = createRoute({
  method: "get",
  path: "/notices",
  summary: "The caller's notices in the app",
  description:
    "What must reach the person even without a push, newest first, at most 20: today a moderator's warning, with its reason, until it is lifted. A notice holds no text of its own; the app says it.",
  ...bearer,
  responses: {
    200: { description: "The notices.", ...json(Notices) },
    401: unauthenticated,
  },
});

const readNoticeRoute = createRoute({
  method: "post",
  path: "/notices/{id}/read",
  summary: "Mark one of the caller's notices read",
  ...bearer,
  request: { params: NoticeParams },
  responses: {
    204: { description: "Read, now or before." },
    400: errorContent("validation_failed: the id is not a uuid."),
    401: unauthenticated,
    404: errorContent("not_found: no such notice of the caller's."),
  },
});

export function notificationRoutes(deps: Deps, guard: MiddlewareHandler<AppEnv>) {
  const app = new OpenAPIHono<AppEnv>();
  const now = deps.now ?? (() => new Date());
  // On the routing paths themselves, which app.test.ts holds every guarded route to.
  for (const route of [choicesRoute, setChoiceRoute, noticesRoute, readNoticeRoute]) {
    app.use(route.getRoutingPath(), guard);
  }

  app.openapi(choicesRoute, async (c) => {
    const { accountId } = callerOf(c);
    return c.json({ choices: await choicesOf(deps.db, accountId) }, 200);
  });

  app.openapi(setChoiceRoute, async (c) => {
    const { accountId } = callerOf(c);
    const { kind } = c.req.valid("param");
    const { enabled } = c.req.valid("json");
    return c.json(
      { choices: await setChoice({ db: deps.db, now }, { accountId, kind, enabled }) },
      200,
    );
  });

  app.openapi(noticesRoute, async (c) => {
    const { accountId } = callerOf(c);
    return c.json(await noticesOf(deps.db, accountId), 200);
  });

  app.openapi(readNoticeRoute, async (c) => {
    const { accountId } = callerOf(c);
    const { id } = c.req.valid("param");
    await readNotice({ db: deps.db, now }, { accountId, noticeId: id });
    return c.body(null, 204);
  });

  return app;
}
