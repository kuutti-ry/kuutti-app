import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  ChatMessage,
  ContactKindParams,
  ConversationContacts,
  ConversationDetail,
  ConversationList,
  ConversationListQuery,
  ConversationParams,
  ErrorResponse,
  MessagePage,
  MessagesQuery,
  PHOTO_MAX_BYTES,
  PutContactRequest,
  ReadRequest,
  SendMessageRequest,
  SendPhotoRequest,
  StoredContact,
  StoredContacts,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Deps } from "../app.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { AppError, localisedEnvelope } from "../lib/errors.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import { personOf, rateLimit } from "../lib/rate-limit.ts";
import { dayWindow } from "../media/index.ts";
import {
  keepContact,
  listContacts,
  readContacts,
  removeContact,
  shareContact,
  stopSharing,
} from "./contacts.ts";
import {
  type ChatDeps,
  listConversations,
  readConversation,
  unmatchConversation,
} from "./conversations.ts";
import { MESSAGES_PER_MINUTE_KEY, markRead, readMessages, sendMessage } from "./messages.ts";
import { MESSAGE_PHOTO_ATTEMPTS_PER_DAY_KEY, sendPhoto } from "./photos.ts";

/** The pipeline at capacity (media/photos.ts' RETRY_AFTER_SECONDS): a moment, as the profile upload says. */
const MEDIA_BUSY_RETRY_AFTER_SECONDS = 5;

// The chat's routes (#348, ADR-031): the list, one conversation, its pages,
// the send, the read mark and the unmatch (#351); the person's own contacts and their shares in
// a conversation (#103, ADR-031 §11). All behind the session guard; every
// statement goes through the caller's participant row (rule 6), and a
// conversation the caller is not in, or one hidden from its blocker, is a
// 404, never a 403. What a message says, and a contact, reach no log line
// (rule 5): the request line names the route and the status.

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
const budgetSpent = errorContent(
  "message_budget_exceeded: the minute's messages, shares and contact changes are spent; Retry-After is the wait.",
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
    "The summary, the longest message the composer may send, the highest sequence the counterpart has read, and the contacts (#103): the caller's stored pieces, each shared here or not, and the counterpart's pieces shared with the caller now. In a closed conversation nothing is shared either way.",
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

const photoRoute = createRoute({
  method: "post",
  path: "/conversations/{id}/photos",
  summary: "Send a photo",
  description:
    "One request uploads and sends (#350): the picture through the photo pipeline (validated, EXIF stripped, re-encoded, the variants, the original never stored), the automatic check before anything is stored, then the photo and its message in one transaction, as a text is sent. A clientId already stored answers 200 with that message and writes nothing. The caption follows the text's rules. At most matching_config message_photos_per_day a Finnish day, and the send counts against messages_per_minute. A Finnish day also counts the sends tried, refused ones included (matching_config message_photo_attempts_per_day). The answer carries the photo's thumb and full size, signed until the next five-minute mark plus fifteen minutes.",
  ...bearer,
  request: {
    params: ConversationParams,
    body: {
      required: true,
      content: { "multipart/form-data": { schema: SendPhotoRequest } },
    },
  },
  responses: {
    200: { description: "Sent before: the stored message, nothing written.", ...json(ChatMessage) },
    201: { description: "Sent.", ...json(ChatMessage) },
    400: errorContent(
      "validation_failed (no picture, a type other than JPEG, PNG or WebP, a malformed client id, an unknown field, a client id the other side used); message_too_long and contact_details for the caption; photo_rejected_nudity, photo_rejected_violence or photo_rejected_other: the check was sure, and nothing was stored.",
    ),
    401: unauthenticated,
    404: notFound,
    409: errorContent(
      "conversation_closed: closed, a block stands between the two, or the counterpart deleted their account; nothing was stored.",
    ),
    413: errorContent("payload_too_large: over 10 MB."),
    415: errorContent("photo_unsupported: not a picture the pipeline reads."),
    422: errorContent("photo_invalid or photo_too_many_pixels."),
    429: errorContent(
      "message_budget_exceeded (the minute's messages) or message_photo_budget_exceeded (the day's photos, or the day's tries, matching_config message_photo_attempts_per_day, both until midnight in Finland); Retry-After is the wait.",
    ),
    503: errorContent(
      "media_busy (the pipeline at capacity, or the check unavailable; Retry-After) or media_unavailable (no object storage here).",
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

const unmatchRoute = createRoute({
  method: "post",
  path: "/conversations/{id}/unmatch",
  summary: "End the conversation for both, blocking nobody",
  description:
    "The conversation closes for both people (#351): neither can write in it, both read it as ended, with nothing saying who ended it or how, and both may still report it for matching_config report_after_close_days. What either shared there ends with it. One closed already is left as it is.",
  ...bearer,
  request: { params: ConversationParams },
  responses: {
    204: { description: "Ended, or ended before." },
    400: errorContent("validation_failed: the id is not a uuid."),
    401: unauthenticated,
    404: notFound,
  },
});

// Contacts (#103, ADR-031 §11). A value is never in a log line, an error
// detail or a validation message: a refusal names the kind.

const contactsRoute = createRoute({
  method: "get",
  path: "/contacts",
  summary: "The caller's stored contacts",
  description:
    "Up to one phone number, WhatsApp number, Telegram, Instagram and Snapchat username, in that order, each in its stored form. Nobody else sees them until the caller shares one in a conversation.",
  ...bearer,
  responses: {
    200: { description: "The stored pieces.", ...json(StoredContacts) },
    401: unauthenticated,
  },
});

const keepContactRoute = createRoute({
  method: "put",
  path: "/contacts/{kind}",
  summary: "Keep a contact",
  description:
    "Stores the piece of that kind in its one form (normaliseContact: a number in E.164, a Finnish one from 0 to +358; a username without its @, Instagram's and Snapchat's in lower case), replacing the one kept before. A shared piece that changes shows its new value in the conversations where it is shared, at once. Counts against matching_config messages_per_minute.",
  ...bearer,
  request: {
    params: ContactKindParams,
    body: { required: true, ...json(PutContactRequest) },
  },
  responses: {
    200: { description: "Kept.", ...json(StoredContact) },
    400: errorContent(
      "validation_failed (an unknown kind, an empty value or one over 64 characters, an unknown key); contact_invalid: not one of its kind (the detail names the kind, never the value).",
    ),
    401: unauthenticated,
    404: errorContent("not_found: the account was deleted while the request was on its way."),
    429: budgetSpent,
  },
});

const removeContactRoute = createRoute({
  method: "delete",
  path: "/contacts/{kind}",
  summary: "Remove a contact",
  description:
    "Deletes the piece of that kind and, in the same transaction, ends every share of it: it disappears from those conversations at once. Answered alike when none was kept. Counts against matching_config messages_per_minute.",
  ...bearer,
  request: { params: ContactKindParams },
  responses: {
    204: { description: "Removed, or none was kept." },
    400: errorContent("validation_failed: an unknown kind."),
    401: unauthenticated,
    404: errorContent(
      "not_found: the account was deleted, or taken out of the live states, while the request was on its way; nothing was written.",
    ),
    429: budgetSpent,
  },
});

const conversationContactsRoute = createRoute({
  method: "get",
  path: "/conversations/{id}/contacts",
  summary: "What is shared in one conversation",
  description:
    "The detail's contacts alone, by the same rule: the caller's stored pieces, each shared here or not, and the counterpart's pieces shared with the caller now. What the phone reads on a contacts frame and on a resume: it signs no thumb and writes nothing.",
  ...bearer,
  request: { params: ConversationParams },
  responses: {
    200: { description: "The contacts.", ...json(ConversationContacts) },
    400: errorContent("validation_failed: the id is not a uuid."),
    401: unauthenticated,
    404: notFound,
  },
});

const ShareParams = z.object({ ...ConversationParams.shape, ...ContactKindParams.shape });

const shareRoute = createRoute({
  method: "post",
  path: "/conversations/{id}/contacts/{kind}",
  summary: "Share a contact in the conversation",
  description:
    "The other person sees the caller's stored piece of that kind at once, in the conversation's detail, until the caller stops sharing it, removes or changes it, or the conversation closes. In one transaction, as a send: the conversation's row locked, its state read afresh. A share standing already writes nothing. A share brings an archived conversation back. Counts against matching_config messages_per_minute. The answer is the caller's fresh view of the conversation.",
  ...bearer,
  request: { params: ShareParams },
  responses: {
    200: { description: "Shared, or shared already.", ...json(ConversationDetail) },
    400: errorContent("validation_failed: the id is not a uuid, or an unknown kind."),
    401: unauthenticated,
    404: notFound,
    409: errorContent(
      "conversation_closed (closed, a block stands between the two, or the counterpart deleted their account) or contact_not_stored (no piece of that kind is kept); nothing was written.",
    ),
    429: budgetSpent,
  },
});

const stopShareRoute = createRoute({
  method: "delete",
  path: "/conversations/{id}/contacts/{kind}",
  summary: "Stop sharing a contact in the conversation",
  description:
    "The caller's share of that kind there ends, and the other person no longer sees it. Nothing standing answers alike, a closed conversation too. Counts against matching_config messages_per_minute. The answer is the caller's fresh view of the conversation.",
  ...bearer,
  request: { params: ShareParams },
  responses: {
    200: { description: "Stopped, or nothing was shared.", ...json(ConversationDetail) },
    400: errorContent("validation_failed: the id is not a uuid, or an unknown kind."),
    401: unauthenticated,
    404: notFound,
    429: budgetSpent,
  },
});

/**
 * `opened` is the safety slice's check after a conversation's first message
 * (#105, ADR-033), handed in by app.ts so the chat never imports safety;
 * `pushed` is the notifications slice's push after every new message (#102,
 * ADR-055 §4), handed in the same way. `opened` is awaited after the send
 * has committed and changes no answer; `pushed` only starts the push, which
 * runs after the answer, so the answer's timing says nothing of it.
 */
export function chatRoutes(
  deps: Deps,
  guard: MiddlewareHandler<AppEnv>,
  opened?: (accountId: string, conversationId: string) => Promise<void>,
  pushed?: (accountId: string, conversationId: string, seq: number) => void,
) {
  const app = new OpenAPIHono<AppEnv>();
  const chat = (): ChatDeps => ({
    db: deps.db,
    logger: deps.logger,
    now: deps.now ?? (() => new Date()),
    ...(deps.media ? { media: deps.media } : {}),
  });
  // On the routing paths themselves, which app.test.ts holds every guarded route to.
  for (const route of [
    listRoute,
    readRoute,
    markRoute,
    unmatchRoute,
    contactsRoute,
    conversationContactsRoute,
  ]) {
    app.use(route.getRoutingPath(), guard);
  }
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
  // A share and its end, and the keep and the removal of a piece, spend the
  // same minute (#103): one press each, as a message is, and each reaches
  // the other person's phone as a frame, so a script can neither flicker a
  // contact on and off nor rewrite a shared one faster than it could write.
  // The keep and the removal share one path, the share and the stop another.
  app.use(shareRoute.getRoutingPath(), guard, perMinute);
  app.use(keepContactRoute.getRoutingPath(), guard, perMinute);
  // The day's tries (#350): a refused photo is stored nowhere and counts
  // toward no cap, yet costs the pipeline and the check; these count every
  // send a person tries, whatever its answer. The day is the day's photos'
  // own, to midnight in Finland, so the refusal's words hold for both; a
  // restart forgets the tries (TD-3: in process, one box).
  const perDayAttempts = rateLimit({
    limit: () => matchingConfigNumber(deps.db, MESSAGE_PHOTO_ATTEMPTS_PER_DAY_KEY),
    windowMs: 25 * 60 * 60 * 1000,
    windowEnd: (at) => dayWindow(new Date(at)).end.getTime(),
    now: () => chat().now().getTime(),
    keyOf: personOf,
    refuse: (c, retryAfterSeconds) => {
      deps.logger.warn(
        {
          accountId: c.get("accountId"),
          limiter: MESSAGE_PHOTO_ATTEMPTS_PER_DAY_KEY,
          retryAfterSeconds,
        },
        "photo refused",
      );
      return c.json(localisedEnvelope(c, "message_photo_budget_exceeded"), 429);
    },
  });
  // The photo (#350): the guard first, so an unauthenticated body is never
  // read; the day's tries and the person's one minute's bucket, shared with
  // the texts; then the route's own 10 MB cap, which replaces the app-wide
  // one app.ts skips here.
  app.use(
    photoRoute.getRoutingPath(),
    guard,
    perDayAttempts,
    perMinute,
    bodyLimit({
      maxSize: PHOTO_MAX_BYTES,
      onError: (c) => c.json(localisedEnvelope(c, "payload_too_large"), 413),
    }),
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
    if (sent.created && sent.message.seq === 1) await opened?.(accountId, id);
    if (sent.created) pushed?.(accountId, id, sent.message.seq);
    return sent.created ? c.json(sent.message, 201) : c.json(sent.message, 200);
  });

  app.openapi(photoRoute, async (c) => {
    const { accountId } = callerOf(c);
    const { id } = c.req.valid("param");
    const form = c.req.valid("form");
    const caption = form.caption && form.caption.length > 0 ? form.caption : null;
    try {
      const sent = await sendPhoto(chat(), {
        accountId,
        conversationId: id,
        clientId: form.clientId,
        caption,
        bytes: new Uint8Array(await form.photo.arrayBuffer()),
      });
      if (sent.created && sent.message.seq === 1) await opened?.(accountId, id);
      if (sent.created) pushed?.(accountId, id, sent.message.seq);
      return sent.created ? c.json(sent.message, 201) : c.json(sent.message, 200);
    } catch (error) {
      // The wait goes in the header, as a limiter's refusal says it.
      const wait = error instanceof AppError ? retryAfterOf(error) : null;
      if (wait !== null) c.header("Retry-After", String(wait));
      throw error;
    }
  });

  app.openapi(contactsRoute, async (c) => {
    const { accountId } = callerOf(c);
    return c.json(await listContacts(chat(), accountId), 200);
  });

  app.openapi(keepContactRoute, async (c) => {
    const { accountId } = callerOf(c);
    const { kind } = c.req.valid("param");
    const typed = c.req.valid("json").value;
    return c.json(await keepContact(chat(), { accountId, kind, typed }), 200);
  });

  app.openapi(removeContactRoute, async (c) => {
    const { accountId } = callerOf(c);
    const { kind } = c.req.valid("param");
    await removeContact(chat(), { accountId, kind });
    return c.body(null, 204);
  });

  app.openapi(conversationContactsRoute, async (c) => {
    const { accountId } = callerOf(c);
    const { id } = c.req.valid("param");
    return c.json(await readContacts(chat(), accountId, id), 200);
  });

  app.openapi(shareRoute, async (c) => {
    const { accountId } = callerOf(c);
    const { id, kind } = c.req.valid("param");
    return c.json(await shareContact(chat(), { accountId, conversationId: id, kind }), 200);
  });

  app.openapi(stopShareRoute, async (c) => {
    const { accountId } = callerOf(c);
    const { id, kind } = c.req.valid("param");
    return c.json(await stopSharing(chat(), { accountId, conversationId: id, kind }), 200);
  });

  app.openapi(unmatchRoute, async (c) => {
    const { accountId } = callerOf(c);
    const { id } = c.req.valid("param");
    await unmatchConversation(chat(), accountId, id);
    return c.body(null, 204);
  });

  app.openapi(markRoute, async (c) => {
    const { accountId } = callerOf(c);
    const { id } = c.req.valid("param");
    await markRead(chat(), accountId, id, c.req.valid("json").upTo);
    return c.body(null, 204);
  });

  return app;
}

/** The wait a refusal carries: the day's photos, or a busy pipeline or check. */
function retryAfterOf(error: AppError): number | null {
  const detail = error.detail as { retryAfterSeconds?: unknown } | undefined;
  if (typeof detail?.retryAfterSeconds === "number") return detail.retryAfterSeconds;
  if (error.code === "media_busy") return MEDIA_BUSY_RETRY_AFTER_SECONDS;
  return null;
}
