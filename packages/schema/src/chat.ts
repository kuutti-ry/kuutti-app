import { z } from "zod";
import {
  EXPORT_DESCRIPTION_TEXT_MAX,
  EXPORT_PHOTO_PATH_MAX,
  ExportedPhotoReview,
  PhotoDescription,
  PhotoFile,
} from "./media.ts";

// The chat (#348, ADR-031): the conversations a match opens, the text
// messages in them, the read marks. Nothing here carries the other person's
// account id: a counterpart is a name, an age and a thumb, or nobody.

/**
 * The schema's ceiling for a message, in UTF-16 units: what no body may pass
 * whatever the configuration says. The rule a person meets is
 * `matching_config message_max_length` (2000 at launch), in characters,
 * checked by the API on each send as `message_too_long`.
 */
export const MESSAGE_BODY_CEILING = 10_000;
/** The list's preview of the last message: its first characters (#348; the maintainer's to switch to the kind alone). */
export const MESSAGE_PREVIEW_LENGTH = 80;
/** A page of the history, or of what is new since a sequence. */
export const MESSAGES_PAGE_DEFAULT = 50;
export const MESSAGES_PAGE_MAX = 100;
/** The largest sequence a conversation can reach: Postgres's integer. */
export const MESSAGE_SEQ_MAX = 2_147_483_647;
/** A person's conversations per group; matches bound them long before this. */
export const CONVERSATIONS_MAX = 1000;

/** The characters of a message as a person counts them: emoji and letters with marks as one each, as the composer counts them. */
export const messageLength = (body: string): number => [...body].length;

/** How a conversation closed, as the database records it (ADR-031 §2). */
export const ConversationCloseKind = z
  .enum(["block", "unmatch", "erasure", "sanction"])
  .meta({ id: "ConversationCloseKind" });
export type ConversationCloseKind = z.infer<typeof ConversationCloseKind>;

export const ConversationState = z
  .enum(["open", "archived", "closed"])
  .meta({ id: "ConversationState" });
export type ConversationState = z.infer<typeof ConversationState>;

/**
 * How a closed conversation reads to the person still in it (ADR-031 §4):
 * the counterpart deleted their account, or the conversation ended. A block
 * and a sanction read as an ended one: the person blocked learns nothing
 * (ADR-030 §6), and nobody learns of another's sanction (ADR-024 §6).
 */
export const ConversationClosedHow = z
  .enum(["unmatch", "erasure"])
  .meta({ id: "ConversationClosedHow" });
export type ConversationClosedHow = z.infer<typeof ConversationClosedHow>;

/** A text, or a photo (#350) whose caption is the body. */
export const MessageKind = z.enum(["text", "photo"]).meta({ id: "MessageKind" });
export type MessageKind = z.infer<typeof MessageKind>;

/** Whose a message is, seen from the caller. */
export const MessageSide = z.enum(["mine", "theirs"]).meta({ id: "MessageSide" });
export type MessageSide = z.infer<typeof MessageSide>;

export const ConversationParams = z.object({ id: z.uuid() }).meta({ id: "ConversationParams" });
export type ConversationParams = z.infer<typeof ConversationParams>;

/**
 * The counterpart's main photo as a thumb: a signed URL of fifteen minutes,
 * logged as a fetch (ADR-008), the blurhash to paint first, and the photo's
 * id for the cache key (rules/mobile.md). Null when there is none to show:
 * no approved photo, the person not active, or the day's thumbs spent.
 */
export const ConversationThumb = z
  .object({
    photoId: z.uuid(),
    url: z.url(),
    blurhash: z.string().max(100),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: "ConversationThumb" });
export type ConversationThumb = z.infer<typeof ConversationThumb>;

export const CounterpartPerson = z
  .object({
    deleted: z.literal(false),
    name: z.string().max(100),
    /** Whole years by the Finnish calendar, as the card counts them. */
    age: z.int().min(18).max(130),
    thumb: ConversationThumb.nullable(),
  })
  .meta({ id: "CounterpartPerson" });

/** The counterpart deleted their account: the app says "Deleted user". */
export const CounterpartDeleted = z
  .object({ deleted: z.literal(true) })
  .meta({ id: "CounterpartDeleted" });

export const Counterpart = z
  .discriminatedUnion("deleted", [CounterpartPerson, CounterpartDeleted])
  .meta({ id: "Counterpart" });
export type Counterpart = z.infer<typeof Counterpart>;

export const LastMessage = z
  .object({
    /** Its place in the conversation: what the app's resume names as the newest it holds (#349). */
    seq: z.int().min(1),
    at: z.iso.datetime(),
    kind: MessageKind,
    /** The first characters of the text. */
    preview: z.string().max(MESSAGE_PREVIEW_LENGTH * 2),
    side: MessageSide,
  })
  .meta({ id: "LastMessage" });
export type LastMessage = z.infer<typeof LastMessage>;

export const ConversationSummary = z
  .object({
    id: z.uuid(),
    state: ConversationState,
    /** Set when the state is closed, null otherwise. */
    closedHow: ConversationClosedHow.nullable(),
    counterpart: Counterpart,
    /** The newest message the caller may see; null before the first. */
    lastMessage: LastMessage.nullable(),
    /** The counterpart's messages the caller has not read. */
    unread: z.int().min(0),
  })
  .meta({ id: "ConversationSummary" });
export type ConversationSummary = z.infer<typeof ConversationSummary>;

/**
 * `thumbs=false` leaves every thumb null: what the home screen's unread count
 * asks for, so a look at home signs no photo and spends no fetch (ADR-008).
 */
export const ConversationListQuery = z
  .object({ thumbs: z.enum(["true", "false"]).default("true") })
  .strict()
  .meta({ id: "ConversationListQuery" });
export type ConversationListQuery = z.infer<typeof ConversationListQuery>;

/** The list: each group newest first, by the last message or, before one, by the opening. */
export const ConversationList = z
  .object({
    open: z.array(ConversationSummary).max(CONVERSATIONS_MAX),
    archived: z.array(ConversationSummary).max(CONVERSATIONS_MAX),
  })
  .meta({ id: "ConversationList" });
export type ConversationList = z.infer<typeof ConversationList>;

export const ConversationDetail = ConversationSummary.extend({
  /** What the composer needs: the longest message, in characters. */
  limits: z.object({ maxLength: z.int().min(1) }),
  /** The highest sequence the counterpart has read: "Read" goes under the caller's last message at or below it. */
  counterpartReadUpTo: z.int().min(0),
}).meta({ id: "ConversationDetail" });
export type ConversationDetail = z.infer<typeof ConversationDetail>;

/**
 * A photo sent in a conversation (#350): small in the thread from the thumb,
 * full on a tap. The caption is the message's body. `description` is what the
 * check saw (#296), in keys the app says in the viewer's language. The URLs
 * are signed in a page's answer, the read of one message and the send's
 * answer to its sender, until the next five-minute mark plus fifteen
 * minutes (15 to 20 minutes, `expiresAt`); a socket frame carries none
 * (rules/api.md: URLs only inside rate-limited responses), and the phone
 * reads the message again for them. The app caches by `photoId/variant`,
 * never by the URL.
 */
export const ChatPhoto = z
  .object({
    photoId: z.uuid(),
    blurhash: z.string().max(100),
    width: z.int().min(1),
    height: z.int().min(1),
    description: PhotoDescription.nullable(),
    urls: z.object({ thumb: z.url(), full: z.url(), expiresAt: z.iso.datetime() }).nullable(),
  })
  .meta({ id: "ChatPhoto" });
export type ChatPhoto = z.infer<typeof ChatPhoto>;

export const ChatMessage = z
  .object({
    id: z.uuid(),
    /** The message's place in the conversation, from 1. */
    seq: z.int().min(1),
    side: MessageSide,
    kind: MessageKind,
    body: z.string().max(MESSAGE_BODY_CEILING).nullable(),
    createdAt: z.iso.datetime(),
    /**
     * The id the phone gave its own message, so a phone matches what it shows
     * as sending with what arrives (#349); null on the other side's, whose ids
     * stay theirs.
     */
    clientId: z.uuid().nullable(),
    /**
     * A photo message's photo; null on a text, and on a photo message whose
     * photo went with its sender's erasure: "Photo removed" (#350). Whoever
     * may read the message sees its photo, so a block reads like any close.
     */
    photo: ChatPhoto.nullable(),
  })
  .meta({ id: "ChatMessage" });
export type ChatMessage = z.infer<typeof ChatMessage>;

const seqParam = z.coerce.number().int().min(0).max(MESSAGE_SEQ_MAX);

/**
 * `before` pages back through the history, newest first; `after` reads what
 * is newer than the last sequence the phone holds, oldest first (the resume
 * #349 reuses). Neither: the newest page. Not both.
 */
export const MessagesQuery = z
  .object({
    before: seqParam.optional(),
    after: seqParam.optional(),
    limit: z.coerce.number().int().min(1).max(MESSAGES_PAGE_MAX).default(MESSAGES_PAGE_DEFAULT),
  })
  .strict()
  .refine((query) => query.before === undefined || query.after === undefined, {
    message: "Either before or after, not both",
  })
  .meta({ id: "MessagesQuery" });
export type MessagesQuery = z.infer<typeof MessagesQuery>;

export const MessagePage = z
  .object({ messages: z.array(ChatMessage).max(MESSAGES_PAGE_MAX) })
  .meta({ id: "MessagePage" });
export type MessagePage = z.infer<typeof MessagePage>;

/**
 * A text message. `clientId` is the phone's own id for it: a resend with the
 * same one after a lost answer is answered with the message stored the first
 * time, and nothing is written twice. The body is trimmed; an empty one is
 * refused here, a long one by the API against message_max_length.
 */
export const SendMessageRequest = z
  .object({
    clientId: z.uuid(),
    body: z
      .string()
      .trim()
      .min(1)
      .max(MESSAGE_BODY_CEILING)
      // The database takes no NUL in a text; refused here rather than failing there.
      .refine((body) => !body.includes("\u0000"), "No NUL character"),
  })
  .strict()
  .meta({ id: "SendMessageRequest" });
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

/**
 * A photo sent in a conversation (#350), one request that uploads and sends,
 * multipart: the picture, the phone's id for the message (a resend with it
 * doubles nothing), and an optional caption under the text rules, whose
 * blank reads as none.
 */
export const SendPhotoRequest = z
  .object({
    photo: PhotoFile,
    clientId: z.uuid(),
    caption: z
      .string()
      .trim()
      .max(MESSAGE_BODY_CEILING)
      .refine((caption) => !caption.includes("\u0000"), "No NUL character")
      .optional(),
  })
  .strict()
  .meta({ id: "SendPhotoRequest" });
export type SendPhotoRequest = z.infer<typeof SendPhotoRequest>;

/** Read up to this sequence; the mark never goes back, nor past the newest message. */
export const ReadRequest = z
  .object({ upTo: z.int().min(0).max(MESSAGE_SEQ_MAX) })
  .strict()
  .meta({ id: "ReadRequest" });
export type ReadRequest = z.infer<typeof ReadRequest>;

/**
 * A photo the person sent, on its line of their export (#350, ADR-007 §3):
 * what a profile photo's entry says, its file, the check's outcome and its
 * description, with the time and the caption on the line.
 */
export const ExportedSentPhoto = z
  .object({
    /** The full-size file in the zip, `photos/<id>.webp`; null when the zip does not carry it: its object is gone, or it is not among the newest sent photos. */
    file: z.string().max(EXPORT_PHOTO_PATH_MAX).nullable(),
    /** For a sent photo, `queued` is one the check was unsure of, delivered and put to no person (ADR-031 §10). */
    review: ExportedPhotoReview.nullable(),
    description: PhotoDescription.nullable(),
    /** The description in words, in the request's language (#296); null where there is none. */
    descriptionText: z.string().max(EXPORT_DESCRIPTION_TEXT_MAX).nullable(),
  })
  .meta({ id: "ExportedSentPhoto" });
export type ExportedSentPhoto = z.infer<typeof ExportedSentPhoto>;

/**
 * A conversation in the person's own export (ADR-007 §4, ADR-031 §5): when it
 * opened and how it stands, the person's own messages with their words, and
 * the counterpart's as a time and a length only: the other person's words
 * stay theirs. Never the counterpart's id or name.
 */
export const ExportedConversation = z
  .object({
    openedAt: z.iso.datetime(),
    state: ConversationState,
    closedHow: ConversationClosedHow.nullable(),
    mine: z
      .array(
        z.object({
          at: z.iso.datetime(),
          kind: MessageKind,
          /** The words, or a photo's caption ("" without one). */
          body: z.string().max(MESSAGE_BODY_CEILING),
          /** The photo the person sent (#350); null for a text, or once the photo went. */
          photo: ExportedSentPhoto.nullable(),
        }),
      )
      .max(1_000_000),
    /** The counterpart's: when, what kind and how long, never the words (the caption's length for a photo). */
    theirs: z
      .array(z.object({ at: z.iso.datetime(), kind: MessageKind, length: z.int().min(0) }))
      .max(1_000_000),
  })
  .meta({ id: "ExportedConversation" });
export type ExportedConversation = z.infer<typeof ExportedConversation>;

/** The research events' coarse lengths (ADR-011 §1 and §9): a band, never the count. */
export const MessageLengthBand = z
  .enum(["0", "1-20", "21-80", "81-280", "281-1000", "1001+"])
  .meta({ id: "MessageLengthBand" });
export type MessageLengthBand = z.infer<typeof MessageLengthBand>;

/** "0" is a photo sent without a caption (#350); a text is never empty. */
export function messageLengthBand(length: number): MessageLengthBand {
  if (length === 0) return "0";
  if (length <= 20) return "1-20";
  if (length <= 80) return "21-80";
  if (length <= 280) return "81-280";
  if (length <= 1000) return "281-1000";
  return "1001+";
}

/** The research events' coarse waits (ADR-011 §1 and §9): a band, never seconds. */
export const ElapsedBand = z
  .enum(["under_1m", "1m_1h", "1h_1d", "1d_7d", "7d_plus"])
  .meta({ id: "ElapsedBand" });
export type ElapsedBand = z.infer<typeof ElapsedBand>;

export function elapsedBand(ms: number): ElapsedBand {
  if (ms < 60_000) return "under_1m";
  if (ms < 3_600_000) return "1m_1h";
  if (ms < 86_400_000) return "1h_1d";
  if (ms < 7 * 86_400_000) return "1d_7d";
  return "7d_plus";
}

/** The research events' coarse counts of messages (ADR-011 §1 and §9): a band, never the count. */
export const MessageCountBand = z
  .enum(["0", "1-5", "6-20", "21-100", "101+"])
  .meta({ id: "MessageCountBand" });
export type MessageCountBand = z.infer<typeof MessageCountBand>;

export function messageCountBand(messages: number): MessageCountBand {
  if (messages <= 0) return "0";
  if (messages <= 5) return "1-5";
  if (messages <= 20) return "6-20";
  if (messages <= 100) return "21-100";
  return "101+";
}

/** The research events' coarse ages of a conversation, in whole days: a band, never the count. */
export const DaysBand = z.enum(["0-6", "7-13", "14-29", "30-89", "90+"]).meta({ id: "DaysBand" });
export type DaysBand = z.infer<typeof DaysBand>;

export function daysBand(days: number): DaysBand {
  if (days < 7) return "0-6";
  if (days < 14) return "7-13";
  if (days < 30) return "14-29";
  if (days < 90) return "30-89";
  return "90+";
}
