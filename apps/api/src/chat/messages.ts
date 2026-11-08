import { type Queryable, transaction } from "@kuutti/db";
import {
  type ChatMessage,
  elapsedBand,
  type MessagePage,
  type MessagesQuery,
  messageLength,
  messageLengthBand,
} from "@kuutti/schema";
import { AppError } from "../lib/errors.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import { issueMessagePhotoUrls } from "../media/index.ts";
import { contactDetailsIn } from "../profile/index.ts";
import { track } from "../research/index.ts";
import {
  type ChatDeps,
  MESSAGE_MAX_LENGTH_KEY,
  requireConversation,
  stateOf,
} from "./conversations.ts";
import * as repo from "./repo.ts";

// Text messages (#348, ADR-031 §3): the send with every refusal, the pages of
// the history and of what is new, the read mark. The text reaches no log
// line, error detail or event (rule 5): the request line says the route and
// the status, a refusal its code, the event the length's band.

export const MESSAGES_PER_MINUTE_KEY = "messages_per_minute";

/**
 * A message as the account on `side` reads it: the phone's own id only on its
 * own messages, a photo without its URLs (withPhotoUrls signs them where the
 * answer may carry them, #350).
 */
export const toMessage = (row: repo.MessageRow, side: repo.Side): ChatMessage => ({
  id: row.id,
  seq: row.seq,
  side: row.side === side ? "mine" : "theirs",
  kind: row.kind,
  body: row.body,
  createdAt: row.createdAt.toISOString(),
  clientId: row.side === side ? row.clientId : null,
  photo: row.photo
    ? {
        photoId: row.photo.id,
        blurhash: row.photo.blurhash,
        width: row.photo.width,
        height: row.photo.height,
        description: row.photo.description,
        urls: null,
      }
    : null,
});

/**
 * The photos of an answer, signed for the reader (#350): each photo message's
 * thumb and full size, logged as fetches of the reader's that the day's
 * budget never counts. A photo follows its message: whoever may read the
 * message sees it, so a closed conversation reads alike whatever closed it,
 * and a block is never told apart from an unmatch (ADR-030 §6). Without media
 * configured, a photo has no URLs.
 */
export async function withPhotoUrls(
  deps: ChatDeps,
  input: {
    viewerAccountId: string;
    side: repo.Side;
    rows: readonly repo.MessageRow[];
  },
): Promise<ChatMessage[]> {
  const messages = input.rows.map((row) => toMessage(row, input.side));
  const photos = input.rows.flatMap((row) => (row.photo ? [row.photo] : []));
  if (!deps.media || photos.length === 0) return messages;
  const urls = await issueMessagePhotoUrls(
    { ...deps.media, db: deps.db, logger: deps.logger, now: deps.now },
    { viewerAccountId: input.viewerAccountId, photos },
  );
  return messages.map((message) => {
    const signed = message.photo ? urls?.get(message.photo.photoId) : undefined;
    return message.photo && signed
      ? { ...message, photo: { ...message.photo, urls: signed } }
      : message;
  });
}

type Outcome =
  | { kind: "not_found" }
  | { kind: "foreign_client_id" }
  | { kind: "stored"; message: ChatMessage }
  | { kind: "closed" }
  | { kind: "too_long"; maxLength: number }
  | { kind: "contact_details"; contact: string }
  | {
      kind: "created";
      message: ChatMessage;
      openedAt: Date;
      previousAt: Date | null;
    };

/**
 * One send, in one transaction (ADR-031 §3): the caller's account held, the
 * conversation's row locked, then what the send decides on read afresh, so
 * that a block, a close or an erasure that committed meanwhile refuses it.
 * The phone's id first: a resend of a message already stored is answered
 * with it and writes nothing, whatever happened since. Then the refusals, in
 * words through the envelope: closed (by a close, a block either way, or the
 * counterpart's erasure), too long after trimming, and contact details.
 * The rate is the route's limiter's (messages_per_minute).
 */
export async function sendMessage(
  deps: ChatDeps,
  input: { accountId: string; conversationId: string; clientId: string; body: string },
): Promise<{ message: ChatMessage; created: boolean }> {
  const at = deps.now();
  const maxLength = await matchingConfigNumber(deps.db, MESSAGE_MAX_LENGTH_KEY);
  const outcome = await transaction(deps.db, async (tx): Promise<Outcome> => {
    if (!(await repo.holdLiveAccount(tx, input.accountId))) return { kind: "not_found" };
    if (!(await repo.lockConversation(tx, input.accountId, input.conversationId))) {
      return { kind: "not_found" };
    }
    const state = await repo.readSendState(tx, input.accountId, input.conversationId);
    if (!state || state.hidden) return { kind: "not_found" };
    const stored = await repo.findByClientId(tx, input);
    if (stored) {
      // An id the other side used is not the caller's to resend; a phone that makes its ids at random never meets one.
      if (stored.side !== state.side) return { kind: "foreign_client_id" };
      return { kind: "stored", message: toMessage(stored, state.side) };
    }
    if (state.closed) return { kind: "closed" };
    if (messageLength(input.body) > maxLength) return { kind: "too_long", maxLength };
    const contact = contactDetailsIn(input.body);
    if (contact) return { kind: "contact_details", contact };
    const row = await repo.insertMessage(tx, {
      accountId: input.accountId,
      conversationId: input.conversationId,
      side: state.side,
      clientId: input.clientId,
      body: input.body,
      at,
    });
    return {
      kind: "created",
      message: toMessage(row, state.side),
      openedAt: state.openedAt,
      previousAt: state.lastMessageAt,
    };
  });
  switch (outcome.kind) {
    case "not_found":
      throw new AppError(404, "not_found", "No such conversation");
    case "foreign_client_id":
      throw new AppError(400, "validation_failed", "The client id is not the caller's");
    case "closed":
      throw new AppError(409, "conversation_closed", "The conversation is closed");
    case "too_long":
      // The limit, never the text or its length.
      throw new AppError(400, "message_too_long", "The message is too long", {
        maxLength: outcome.maxLength,
      });
    case "contact_details":
      // The kind found, as the card's refusal names it; never the text.
      throw new AppError(400, "contact_details", "Contact details are not for a message", {
        kind: outcome.contact,
      });
    case "stored":
      return { message: outcome.message, created: false };
    case "created": {
      const { message } = outcome;
      await track(
        { db: deps.db, logger: deps.logger, now: () => at },
        input.accountId,
        "message_sent",
        {
          kind: message.kind,
          length: messageLengthBand(messageLength(input.body)),
          firstInConversation: message.seq === 1,
          sinceOpened: elapsedBand(at.getTime() - outcome.openedAt.getTime()),
          sincePrevious:
            outcome.previousAt === null
              ? null
              : elapsedBand(at.getTime() - outcome.previousAt.getTime()),
        },
      );
      return { message, created: true };
    }
  }
}

/** A page of the history (newest first), or of what is newer than `after` (oldest first). */
export async function readMessages(
  deps: ChatDeps,
  accountId: string,
  conversationId: string,
  query: MessagesQuery,
): Promise<MessagePage> {
  const conversation = await requireConversation(deps.db, accountId, conversationId);
  const rows = await repo.listMessages(deps.db, {
    accountId,
    conversationId,
    before: query.before,
    after: query.after,
    limit: query.limit,
  });
  return {
    messages: await withPhotoUrls(deps, {
      viewerAccountId: accountId,
      side: conversation.side,
      rows,
    }),
  };
}

/** The read mark: up, never down, never past the newest message; answered in a closed conversation too, where it stands still. */
export async function markRead(
  deps: ChatDeps,
  accountId: string,
  conversationId: string,
  upTo: number,
): Promise<void> {
  if (!(await repo.markRead(deps.db, { accountId, conversationId, upTo }))) {
    throw new AppError(404, "not_found", "No such conversation");
  }
}

/**
 * Who besides its sender may read message `seq` now, through their own
 * participant row by the socket's rule (#349), in a conversation still open
 * for them: whom a push of it may tell (#102, ADR-055 §4). Nobody across a
 * block or a close, nobody for a shadow-banned sender's withheld message,
 * nobody erased.
 */
export async function messageReaders(
  db: Queryable,
  input: { conversationId: string; seq: number; senderAccountId: string },
): Promise<string[]> {
  const readers: string[] = [];
  for (const { accountId } of await repo.participantsOf(db, input.conversationId)) {
    if (accountId === input.senderAccountId) continue;
    const row = await repo.findConversation(db, accountId, input.conversationId);
    if (!row) continue;
    const open =
      stateOf({
        archivedAt: row.archivedAt,
        closedAt: row.closedAt,
        closedHow: row.closedHow,
        counterpartLinked: row.counterpartId !== null,
        blocked: row.blocked,
      }).state !== "closed";
    const message = await repo.messageFor(db, {
      accountId,
      conversationId: input.conversationId,
      seq: input.seq,
    });
    if (open && message) readers.push(accountId);
  }
  return readers;
}
