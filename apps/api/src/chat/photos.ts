import { type Queryable, transaction } from "@kuutti/db";
import { type ChatMessage, elapsedBand, messageLength, messageLengthBand } from "@kuutti/schema";
import { AppError } from "../lib/errors.ts";
import { matchingConfigNumbers } from "../lib/matching-config.ts";
import {
  countMessagePhotosSince,
  dayWindow,
  type PreparedMessagePhoto,
  prepareMessagePhoto,
  secondsUntil,
  storeMessagePhoto,
} from "../media/index.ts";
import { contactDetailsIn } from "../profile/index.ts";
import { track } from "../research/index.ts";
import { type ChatDeps, MESSAGE_MAX_LENGTH_KEY } from "./conversations.ts";
import { withPhotoUrls } from "./messages.ts";
import * as repo from "./repo.ts";

// A photo in a message (#350, ADR-031 §3): one request uploads and sends.
// The pipeline is the profile photo's (rule 4), with purpose `message`; the
// check reads it before anything is stored; the photo's row and its message
// are one transaction. The caption follows the text rules and, like a text,
// reaches no log line or event (rule 5).

const MESSAGE_PHOTOS_PER_DAY_KEY = "message_photos_per_day";
/** The sends a person may try in a day, refused ones included (the route's limiter). */
export const MESSAGE_PHOTO_ATTEMPTS_PER_DAY_KEY = "message_photo_attempts_per_day";

/** The route's path, which app.ts lets past the app-wide body cap: its own 10 MB cap sits on the route. */
export const PHOTO_MESSAGE_PATH = /^\/conversations\/[^/]+\/photos$/;

type Before =
  | { kind: "stored"; row: repo.MessageRow; side: repo.Side }
  | { kind: "send"; perDay: number };

type Outcome =
  | { kind: "not_found" }
  | { kind: "foreign_client_id" }
  | { kind: "stored"; row: repo.MessageRow; side: repo.Side }
  | { kind: "closed" }
  | { kind: "over_budget" }
  | {
      kind: "created";
      row: repo.MessageRow;
      side: repo.Side;
      openedAt: Date;
      previousAt: Date | null;
    };

/**
 * One photo sent (#350). Refused before any pixel is touched where the
 * answer is already known: no such conversation, a resend (answered with the
 * stored message), the other side's id, closed, a caption too long or with
 * contact details, the day's photos sent. Then the pipeline and the check
 * (prepareMessagePhoto: a refusal in words stores nothing). Then one
 * transaction, the send's own (the account held, the conversation's row
 * locked, the state read afresh) with the sender's lock for the day's count,
 * so a burst never passes the cap. Every path that writes no row removes the
 * objects again, unless an earlier photo of the same content keeps them.
 */
export async function sendPhoto(
  deps: ChatDeps,
  input: {
    accountId: string;
    conversationId: string;
    clientId: string;
    caption: string | null;
    bytes: Uint8Array;
  },
): Promise<{ message: ChatMessage; created: boolean }> {
  const media = deps.media;
  if (!media) throw new AppError(503, "media_unavailable", "Object storage is not configured here");
  const at = deps.now();
  const day = dayWindow(at);
  const before = await refuseEarly(deps, input, at);
  if (before.kind === "stored") {
    return { message: await present(deps, input.accountId, before), created: false };
  }
  const prepared = await prepareMessagePhoto(
    { ...media, db: deps.db, logger: deps.logger, now: deps.now },
    { accountId: input.accountId, bytes: input.bytes },
  );
  let outcome: Outcome;
  try {
    outcome = await transaction(deps.db, (tx) =>
      writePhotoMessage(tx, input, { prepared, at, since: day.start, perDay: before.perDay }),
    );
  } catch (error) {
    await prepared.dropOrphans();
    throw error;
  }
  if (outcome.kind !== "created") await prepared.dropOrphans();
  switch (outcome.kind) {
    case "not_found":
      throw new AppError(404, "not_found", "No such conversation");
    case "foreign_client_id":
      throw new AppError(400, "validation_failed", "The client id is not the caller's");
    case "closed":
      throw new AppError(409, "conversation_closed", "The conversation is closed");
    case "over_budget":
      throw budgetRefusal(at, day.end);
    case "stored":
      return { message: await present(deps, input.accountId, outcome), created: false };
    case "created": {
      const message = await present(deps, input.accountId, outcome);
      await track(
        { db: deps.db, logger: deps.logger, now: () => at },
        input.accountId,
        "message_sent",
        {
          kind: "photo",
          length: messageLengthBand(messageLength(input.caption ?? "")),
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

/** The refusals known without a pixel or a lock; the transaction asks each again. */
async function refuseEarly(
  deps: ChatDeps,
  input: { accountId: string; conversationId: string; clientId: string; caption: string | null },
  at: Date,
): Promise<Before> {
  const state = await repo.readSendState(deps.db, input.accountId, input.conversationId);
  if (!state || state.hidden) throw new AppError(404, "not_found", "No such conversation");
  const stored = await repo.findByClientId(deps.db, input);
  if (stored) {
    if (stored.side !== state.side) {
      throw new AppError(400, "validation_failed", "The client id is not the caller's");
    }
    return { kind: "stored", row: stored, side: state.side };
  }
  if (state.closed) throw new AppError(409, "conversation_closed", "The conversation is closed");
  const limits = await matchingConfigNumbers(deps.db, [
    MESSAGE_MAX_LENGTH_KEY,
    MESSAGE_PHOTOS_PER_DAY_KEY,
  ]);
  const maxLength = limits[MESSAGE_MAX_LENGTH_KEY];
  const perDay = limits[MESSAGE_PHOTOS_PER_DAY_KEY];
  if (input.caption !== null) {
    if (messageLength(input.caption) > maxLength) {
      throw new AppError(400, "message_too_long", "The caption is too long", { maxLength });
    }
    const contact = contactDetailsIn(input.caption);
    if (contact) {
      throw new AppError(400, "contact_details", "Contact details are not for a message", {
        kind: contact,
      });
    }
  }
  const day = dayWindow(at);
  if ((await countMessagePhotosSince(deps.db, input.accountId, day.start)) >= perDay) {
    throw budgetRefusal(at, day.end);
  }
  return { kind: "send", perDay };
}

/**
 * The transaction (ADR-031 §3, the send's order): the sender's lock for the
 * day's count first, which nothing else takes, then the account held and
 * the conversation's row locked, then what the send decides on, read afresh.
 */
async function writePhotoMessage(
  tx: Queryable,
  input: { accountId: string; conversationId: string; clientId: string; caption: string | null },
  photo: { prepared: PreparedMessagePhoto; at: Date; since: Date; perDay: number },
): Promise<Outcome> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `message_photo:${input.accountId}`,
  ]);
  if (!(await repo.holdLiveAccount(tx, input.accountId))) return { kind: "not_found" };
  // Locked through the caller's participant row; without one, the state below is none too.
  await repo.lockConversation(tx, input.accountId, input.conversationId);
  const state = await repo.readSendState(tx, input.accountId, input.conversationId);
  if (!state || state.hidden) return { kind: "not_found" };
  const stored = await repo.findByClientId(tx, input);
  if (stored) {
    if (stored.side !== state.side) return { kind: "foreign_client_id" };
    return { kind: "stored", row: stored, side: state.side };
  }
  if (state.closed) return { kind: "closed" };
  if ((await countMessagePhotosSince(tx, input.accountId, photo.since)) >= photo.perDay) {
    return { kind: "over_budget" };
  }
  const photoId = await storeMessagePhoto(tx, {
    accountId: input.accountId,
    photo: photo.prepared,
    at: photo.at,
  });
  if (!photoId) return { kind: "not_found" };
  const row = await repo.insertMessage(tx, {
    accountId: input.accountId,
    conversationId: input.conversationId,
    side: state.side,
    clientId: input.clientId,
    body: input.caption,
    at: photo.at,
    photoId,
  });
  return {
    kind: "created",
    row,
    side: state.side,
    openedAt: state.openedAt,
    previousAt: state.lastMessageAt,
  };
}

/** The sender's own message, its photo signed for them. */
async function present(
  deps: ChatDeps,
  accountId: string,
  sent: { row: repo.MessageRow; side: repo.Side },
): Promise<ChatMessage> {
  const [message] = await withPhotoUrls(deps, {
    viewerAccountId: accountId,
    side: sent.side,
    rows: [sent.row],
  });
  if (!message) throw new Error("a sent message did not present");
  return message;
}

/** The day's photos are sent: the wait is until midnight in Finland. */
function budgetRefusal(at: Date, end: Date): AppError {
  return new AppError(429, "message_photo_budget_exceeded", "The day's photos are sent", {
    retryAfterSeconds: secondsUntil(end, at),
  });
}
