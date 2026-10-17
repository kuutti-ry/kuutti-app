import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  ChatMessage,
  ConversationDetail,
  ConversationList,
  ConversationListQuery,
  ConversationParams,
  ErrorResponse,
  MessagePage,
  MessagesQuery,
  ReadRequest,
  SendMessageRequest,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { localisedEnvelope } from "../lib/errors.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import { personOf, rateLimit } from "../lib/rate-limit.ts";
import { type ChatDeps, listConversations, readConversation } from "./conversations.ts";
import { MESSAGES_PER_MINUTE_KEY, markRead, readMessages, sendMessage } from "./messages.ts";

// The chat's routes (#348, ADR-031): the list, one conversation, its pages,
// the send and the read mark. All behind the session guard; every statement
// goes through the caller's participant row (rule 6), and a conversation the
// caller is not in, or one hidden from its blocker, is a 404, never a 403.
// What a message says reaches no log line (rule 5): the request line names
// the route and the status.

const errorContent = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const bearer = { security: [{ session: [] }] };
const unauthenticated = errorContent("unauthenticated, session_expired or session_revoked.");
const notFound = errorContent(
  "not_found: no such conversation for the caller: not theirs, nobody's, or hidden from the one who blocked the other.",
);

const listRoute = createRoute({
  method: "get",
  path: "/conversations",
  summary: "The caller's conversations",
  description:
    "Open conversations, then the archived and the closed ones, each newest first by the last message the caller may read, else by the opening. Each with the counterpart (name, age and the main photo's thumb, signed for fifteen minutes and logged as a fetch; or deleted), the last message's first characters and the unread count. With thumbs=false, no thumb is signed.",
  ...bearer,
  request: { query: ConversationListQuery },
  responses: {
    200: { description: "The two groups.", ...json(ConversationList) },
    400: errorContent("Validation failed: thumbs other than true or false, an unknown key."),
    401: unauthenticated,
  },
});

const readRoute = createRoute({
  method: "get",
  path: "/conversations/{id}",
  summary: "One conversation",
  description:
    "The summary, the longest message the composer may send, and the highest sequence the counterpart has read.",
  ...bearer,
  request: { params: ConversationParams },
  responses: {
    200: { description: "The conversation.", ...json(ConversationDetail) },
    400: errorContent("Validation failed: the id is not a uuid."),
    401: unauthenticated,
    404: notFound,
  },
});

const pageRoute = createRoute({
  method: "get",
  path: "/conversations/{id}/messages",
  summary: "A page of messages",
  description:
    "With before, the messages under that sequence, newest first; with after, the ones above it, oldest first (what is new since the last one the phone holds); with neither, the newest. At most limit, 50 by default, 100 at most. A counterpart's message sent during a shadow ban still open is not among them.",
  ...bearer,
  request: { params: ConversationParams, query: MessagesQuery },
  responses: {
    200: { description: "The page.", ...json(MessagePage) },
    400: errorContent(
      "Validation failed: before and after together, a sequence or a limit out of range, an unknown key.",
    ),
    401: unauthenticated,
    404: notFound,
  },
});

const sendRoute = createRoute({
  method: "post",
  path: "/conversations/{id}/messages",
  summary: "Send a text message",
  description:
    "In one transaction: the conversation's row locked, the next sequence taken, the last message's time set and the archive left. A clientId already stored answers 200 with that message and writes nothing. At most matching_config messages_per_minute a minute per account, message_max_length characters after trimming, and no e-mail address, link, phone number or handle.",
  ...bearer,
  request: { params: ConversationParams, body: { required: true, ...json(SendMessageRequest) } },
  responses: {
    200: { description: "Sent before: the stored message, nothing written.", ...json(ChatMessage) },
    201: { description: "Sent.", ...json(ChatMessage) },
    400: errorContent(
      "validation_failed (an empty body, a malformed client id, an unknown key, a client id the other side used); message_too_long (over message_max_length after trimming); contact_details (an e-mail address, a link, a phone number or a handle).",
    ),
    401: unauthenticated,
    404: notFound,
    409: errorContent(
      "conversation_closed: closed, a block stands between the two, or the counterpart deleted their account; nothing was written.",
    ),
    429: errorContent(
      "message_budget_exceeded: the minute's messages are sent; Retry-After is the wait.",
    ),
  },
});

const markRoute = createRoute({
  method: "post",
  path: "/conversations/{id}/read",
  summary: "Mark the conversation read up to a sequence",
  description:
    "The caller's read mark goes up to upTo, never down and never past the newest message.",
  ...bearer,
  request: { params: ConversationParams, body: { required: true, ...json(ReadRequest) } },
  responses: {
    204: { description: "Marked." },
    400: errorContent("Validation failed: not a whole sequence from zero, an unknown key."),
    401: unauthenticated,
    404: notFound,
  },
});

export function chatRoutes(deps: Deps, guard: MiddlewareHandler<AppEnv>) {
  const app = new OpenAPIHono<AppEnv>();
  const chat = (): ChatDeps => ({
    db: deps.db,
    logger: deps.logger,
    now: deps.now ?? (() => new Date()),
    ...(deps.media ? { media: deps.media } : {}),
  });
  // On the routing paths themselves, which app.test.ts holds every guarded route to.
  for (const route of [listRoute, readRoute, markRoute]) app.use(route.getRoutingPath(), guard);
  // The send's own limit, after the guard, keyed by the account (ADR-026),
  // its number the matching_config row read on each request. The page and
  // the send share the path: one guard for both, and only the send is counted.
  const perMinute = rateLimit({
    limit: () => matchingConfigNumber(deps.db, MESSAGES_PER_MINUTE_KEY),
    windowMs: 60_000,
    keyOf: personOf,
    refuse: (c, retryAfterSeconds) => {
      // Which limit refused and the wait, never the key (ADR-026 §7).
      deps.logger.warn(
        { accountId: c.get("accountId"), limiter: MESSAGES_PER_MINUTE_KEY, retryAfterSeconds },
        "message refused",
      );
      return c.json(localisedEnvelope(c, "message_budget_exceeded"), 429);
    },
  });
  app.use(sendRoute.getRoutingPath(), guard, (c, next) =>
    c.req.method === "POST" ? perMinute(c, next) : next(),
  );

  app.openapi(listRoute, async (c) => {
    const { accountId } = callerOf(c);
    const { thumbs } = c.req.valid("query");
    return c.json(await listConversations(chat(), accountId, { thumbs: thumbs === "true" }), 200);
  });

  app.openapi(readRoute, async (c) => {
    const { accountId } = callerOf(c);
    const { id } = c.req.valid("param");
    return c.json(await readConversation(chat(), accountId, id), 200);
  });

  app.openapi(pageRoute, async (c) => {
    const { accountId } = callerOf(c);
    const { id } = c.req.valid("param");
    return c.json(await readMessages(chat(), accountId, id, c.req.valid("query")), 200);
  });

  app.openapi(sendRoute, async (c) => {
    const { accountId } = callerOf(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const sent = await sendMessage(chat(), {
      accountId,
      conversationId: id,
      clientId: body.clientId,
      body: body.body,
    });
    return sent.created ? c.json(sent.message, 201) : c.json(sent.message, 200);
  });

  app.openapi(markRoute, async (c) => {
    const { accountId } = callerOf(c);
    const { id } = c.req.valid("param");
    await markRead(chat(), accountId, id, c.req.valid("json").upTo);
    return c.body(null, 204);
  });

  return app;
}
