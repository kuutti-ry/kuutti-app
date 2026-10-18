import { z } from "zod";
import {
  ChatMessage,
  CONVERSATIONS_MAX,
  ConversationClosedHow,
  ConversationState,
  MESSAGE_SEQ_MAX,
} from "./chat.ts";
import { SessionToken } from "./identity.ts";

// The chat's socket (#349, ADR-031 §5): what the phone and the API say to
// each other over GET /ws. Every frame in either direction is one of these,
// parsed on arrival; a frame that is none of them closes the socket. Writing
// stays on the HTTP routes: the socket tells the phone what changed.

/** The largest frame either side sends, in bytes: a resume naming every conversation fits, a message frame too. */
export const FRAME_BYTES_MAX = 256 * 1024;

/** Codes of the `error` frame, sent just before the API closes the socket. Never says why a session ended. */
export const FrameErrorCode = z
  .enum([
    "bad_frame",
    "auth_timeout",
    "unauthenticated",
    "session_revoked",
    "session_expired",
    "too_many_sockets",
    "pong_timeout",
    "restarting",
    "internal_error",
  ])
  .meta({ id: "FrameErrorCode" });
export type FrameErrorCode = z.infer<typeof FrameErrorCode>;

const conversationId = z.uuid();

/** The phone's first frame: the access token, never in the URL (#349). */
export const AuthFrame = z
  .object({ type: z.literal("auth"), token: SessionToken })
  .strict()
  .meta({ id: "AuthFrame" });

/**
 * After every `ready`: the newest sequence the phone holds per conversation,
 * each conversation once. The API answers with the messages after it, in
 * order, a page at most, and the counterpart's presence and read mark.
 */
export const ResumeFrame = z
  .object({
    type: z.literal("resume"),
    conversations: z
      .array(z.object({ id: conversationId, seq: z.int().min(0).max(MESSAGE_SEQ_MAX) }).strict())
      .max(CONVERSATIONS_MAX * 2)
      // Each conversation once: a name repeated would replay it again.
      .refine((list) => new Set(list.map((c) => c.id)).size === list.length),
  })
  .strict()
  .meta({ id: "ResumeFrame" });

export const PongFrame = z
  .object({ type: z.literal("pong") })
  .strict()
  .meta({ id: "PongFrame" });

export const ClientFrame = z
  .discriminatedUnion("type", [AuthFrame, ResumeFrame, PongFrame])
  .meta({ id: "ClientFrame" });
export type ClientFrame = z.infer<typeof ClientFrame>;

export const ServerFrame = z
  .discriminatedUnion("type", [
    /** The token held: the phone sends its resume. */
    z.object({ type: z.literal("ready") }).strict(),
    /** A message committed in one of the account's conversations, as this account reads it. */
    z.object({ type: z.literal("message"), conversationId, message: ChatMessage }).strict(),
    /** The counterpart read up to this sequence. */
    z
      .object({
        type: z.literal("read"),
        conversationId,
        upTo: z.int().min(0).max(MESSAGE_SEQ_MAX),
      })
      .strict(),
    /** The counterpart opened their first socket, or closed their last. */
    z.object({ type: z.literal("presence"), conversationId, online: z.boolean() }).strict(),
    /**
     * How the conversation stands for this account now: open, archived,
     * closed with how, or gone (hidden from the one who blocked).
     */
    z
      .object({
        type: z.literal("conversation"),
        conversationId,
        state: z.union([ConversationState, z.literal("gone")]),
        closedHow: ConversationClosedHow.nullable(),
      })
      .strict(),
    /**
     * What is shared in the conversation changed (#103): a share began or
     * ended, or a shared piece changed. Never a value: the phone reads the
     * conversation again over HTTP.
     */
    z.object({ type: z.literal("contacts"), conversationId }).strict(),
    z.object({ type: z.literal("ping") }).strict(),
    /** Just before the API closes the socket. */
    z.object({ type: z.literal("error"), code: FrameErrorCode }).strict(),
  ])
  .meta({ id: "ServerFrame" });
export type ServerFrame = z.infer<typeof ServerFrame>;
