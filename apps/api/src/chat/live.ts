import type { Queryable } from "@kuutti/db";
import {
  CONVERSATIONS_MAX,
  type FrameErrorCode,
  MESSAGES_PAGE_MAX,
  type ServerFrame,
} from "@kuutti/schema";
import { z } from "zod";
import type { Logger } from "../lib/logger.ts";
import { stateOf } from "./conversations.ts";
import { toMessage } from "./messages.ts";
import { createPresence, type LiveSocket, type Presence } from "./presence.ts";
import * as repo from "./repo.ts";

// The live half of the chat (#349, ADR-031 §5): Postgres is the store, the
// socket the notifier. What changed arrives as a notification on
// CHAT_CHANNEL, sent by the triggers of migration 0055 when its transaction
// commits, with ids and numbers only. The hub turns each into the frames each
// person may see, read through that person's own participant row with every
// rule of #348's reads: nothing crosses a block, a conversation hidden from
// its blocker says it is gone, a shadow-banned sender's message reaches only
// the sender.

export const CHAT_CHANNEL = "kuutti_chat";

/** What the triggers send (packages/db/drizzle/0055_chat_notify.sql). */
const Notification = z.discriminatedUnion("t", [
  z.object({ t: z.literal("message"), c: z.uuid(), s: z.int().min(1) }),
  z.object({ t: z.literal("conversation"), c: z.uuid() }),
  z.object({ t: z.literal("read"), c: z.uuid(), side: z.enum(["a", "b"]), u: z.int().min(0) }),
  z.object({ t: z.literal("session"), id: z.uuid() }),
  z.object({ t: z.literal("block"), a: z.uuid(), b: z.uuid() }),
]);

/** Runs a task after `ms`; the returned function cancels it. Tests hand in their own. */
export type Schedule = (ms: number, task: () => void) => () => void;

const realSchedule: Schedule = (ms, task) => {
  const timer = setTimeout(task, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

function createChatHub(deps: { db: Queryable; logger: Logger; presence: Presence }) {
  const { db, logger, presence } = deps;
  const sendTo = (accountId: string, frame: ServerFrame) => {
    for (const socket of presence.socketsOf(accountId)) socket.send(frame);
  };
  const listening = (accountId: string) => presence.socketsOf(accountId).length > 0;
  /** Nobody is online across a close, a block or an erasure. */
  const counterpartOnline = (row: repo.ConversationRow) =>
    visibleState(row).state !== "closed" &&
    row.counterpartId !== null &&
    presence.online(row.counterpartId);

  /** How the conversation stands for this account now, `gone` when it may not see it. */
  async function stateFrame(accountId: string, conversationId: string): Promise<ServerFrame> {
    const row = await repo.findConversation(db, accountId, conversationId);
    if (!row) return { type: "conversation", conversationId, state: "gone", closedHow: null };
    return { type: "conversation", conversationId, ...visibleState(row) };
  }

  async function announceStates(conversationIds: string[]): Promise<void> {
    for (const conversationId of conversationIds) {
      for (const { accountId } of await repo.participantsOf(db, conversationId)) {
        if (listening(accountId)) sendTo(accountId, await stateFrame(accountId, conversationId));
      }
    }
  }

  return {
    /** One notification from the channel; a payload outside the contract is logged by its shape and dropped. */
    async deliver(payload: string): Promise<void> {
      let parsed: ReturnType<typeof Notification.safeParse>;
      try {
        parsed = Notification.safeParse(JSON.parse(payload));
      } catch {
        parsed = Notification.safeParse(undefined);
      }
      if (!parsed.success) {
        logger.warn({ channel: CHAT_CHANNEL }, "chat notification refused");
        return;
      }
      const note = parsed.data;
      switch (note.t) {
        case "message":
          for (const { accountId } of await repo.participantsOf(db, note.c)) {
            if (!listening(accountId)) continue;
            const found = await repo.messageFor(db, {
              accountId,
              conversationId: note.c,
              seq: note.s,
            });
            if (found) {
              sendTo(accountId, {
                type: "message",
                conversationId: note.c,
                message: toMessage(found.row, found.side),
              });
            }
          }
          return;
        case "conversation":
          return announceStates([note.c]);
        case "read": {
          const reader = note.side;
          for (const { accountId, side } of await repo.participantsOf(db, note.c)) {
            if (side === reader || !listening(accountId)) continue;
            const row = await repo.findConversation(db, accountId, note.c);
            // A closed conversation delivers no frame.
            if (row && visibleState(row).state !== "closed") {
              sendTo(accountId, { type: "read", conversationId: note.c, upTo: note.u });
            }
          }
          return;
        }
        case "session":
          // A session ended: its sockets close at once, whatever ended it.
          for (const socket of presence.all()) {
            if (socket.sessionId === note.id) socket.close(1008, "session_revoked");
          }
          return;
        case "block":
          return announceStates(await repo.conversationsBetweenIdentities(db, note.a, note.b));
      }
    },

    /**
     * The account's first socket opened, or its last closed: the counterparts
     * of its open and archived conversations are told, nobody for a
     * shadow-banned account (ADR-024 §6), nothing across a close or a block.
     */
    async announcePresence(socket: LiveSocket, online: boolean): Promise<void> {
      if (socket.hidden) return;
      for (const row of await repo.listConversations(db, socket.accountId, CONVERSATIONS_MAX * 2)) {
        if (row.counterpartId === null || visibleState(row).state === "closed") continue;
        sendTo(row.counterpartId, { type: "presence", conversationId: row.id, online });
      }
    },

    /**
     * The phone's resume: per conversation it names, every message after the
     * sequence it holds, in order, then the counterpart's read mark, presence
     * and the conversation's state; `gone` for one it may not see. A phone
     * resumes as soon as the socket is ready, often before its list has
     * loaded and named anything, so every visible conversation it did not
     * name hears its counterpart's presence first, and the last named
     * conversation's state still ends the answer.
     */
    async resume(
      socket: LiveSocket,
      conversations: ReadonlyArray<{ id: string; seq: number }>,
    ): Promise<void> {
      const named = new Set(conversations.map(({ id }) => id));
      for (const row of await repo.listConversations(db, socket.accountId, CONVERSATIONS_MAX * 2)) {
        if (named.has(row.id)) continue;
        socket.send({ type: "presence", conversationId: row.id, online: counterpartOnline(row) });
      }
      for (const { id, seq } of conversations) {
        const row = await repo.findConversation(db, socket.accountId, id);
        if (!row) {
          socket.send({ type: "conversation", conversationId: id, state: "gone", closedHow: null });
          continue;
        }
        let after = seq;
        for (;;) {
          const page = await repo.listMessages(db, {
            accountId: socket.accountId,
            conversationId: id,
            after,
            limit: MESSAGES_PAGE_MAX,
          });
          for (const message of page) {
            socket.send({
              type: "message",
              conversationId: id,
              message: toMessage(message, row.side),
            });
          }
          const last = page.at(-1);
          if (!last || page.length < MESSAGES_PAGE_MAX) break;
          after = last.seq;
        }
        socket.send({ type: "read", conversationId: id, upTo: row.counterpartReadUpTo });
        socket.send({ type: "presence", conversationId: id, online: counterpartOnline(row) });
        socket.send({ type: "conversation", conversationId: id, ...visibleState(row) });
      }
    },
  };
}

function visibleState(row: repo.ConversationRow) {
  return stateOf({
    archivedAt: row.archivedAt,
    closedAt: row.closedAt,
    closedHow: row.closedHow,
    counterpartLinked: row.counterpartId !== null,
    blocked: row.blocked,
  });
}

export type Live = ReturnType<typeof createLive>;

/**
 * The process's live chat: the registry, the hub over it, and the timers the
 * sockets use. One per app; boot hands the same one to the listener.
 */
export function createLive(deps: {
  db: Queryable;
  logger: Logger;
  socketsPerAccount: number;
  schedule?: Schedule;
}) {
  const presence = createPresence(deps.socketsPerAccount);
  const hub = createChatHub({ db: deps.db, logger: deps.logger, presence });
  return {
    presence,
    hub,
    schedule: deps.schedule ?? realSchedule,
    /** Every socket closed with the code and why: a shutdown, or the listener lost. */
    closeAll(code: number, error: FrameErrorCode): void {
      for (const socket of presence.all()) socket.close(code, error);
    },
    /** Whether the account has a live socket now: what #102's push asks before it sends. */
    online(accountId: string): boolean {
      return presence.socketsOf(accountId).length > 0;
    },
  };
}
