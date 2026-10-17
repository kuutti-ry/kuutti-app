import type { Queryable } from "@kuutti/db";
import {
  CONVERSATIONS_MAX,
  type ConversationClosedHow,
  type ConversationCloseKind,
  type ConversationDetail,
  type ConversationList,
  type ConversationState,
  type ConversationSummary,
  type ConversationThumb,
  type ExportedConversation,
  MESSAGE_PREVIEW_LENGTH,
  messageCountBand,
} from "@kuutti/schema";
import { AppError } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import { issueConversationThumb, type MediaDeps } from "../media/index.ts";
import { ageInYears } from "../profile/index.ts";
import { track } from "../research/index.ts";
import * as repo from "./repo.ts";

// The conversations a person is in (#348, ADR-031): the list with the
// counterpart and the last message, one conversation with what the composer
// needs, and the closes that erasure and a ban make. What a person reads of
// a closed conversation says nothing of a block or a sanction (ADR-030 §6,
// ADR-024 §6): it ended, or the other deleted their account.

export const MESSAGE_MAX_LENGTH_KEY = "message_max_length";

export type ChatDeps = {
  db: Queryable;
  logger: Logger;
  now: () => Date;
  /** Signs the counterpart's thumb; absent where media is not configured, and the thumb is null. */
  media?: MediaDeps;
};

/**
 * How the conversation stands for the caller. Closed when it was closed, when
 * a block stands between the two (#351 writes the close; until then, and in
 * the moment between, the block alone closes it), or when the counterpart is
 * erased. Erasure reads as such; everything else as an ended conversation.
 */
function stateOf(row: {
  archivedAt: Date | null;
  closedAt: Date | null;
  closedHow: ConversationCloseKind | null;
  counterpartLinked: boolean;
  blocked: boolean;
}): { state: ConversationState; closedHow: ConversationClosedHow | null } {
  const closed = row.closedAt !== null || row.blocked || !row.counterpartLinked;
  if (!closed) return { state: row.archivedAt ? "archived" : "open", closedHow: null };
  const erased = row.closedHow === "erasure" || (row.closedHow === null && !row.counterpartLinked);
  return { state: "closed", closedHow: erased ? "erasure" : "unmatch" };
}

const preview = (body: string | null) =>
  [...(body ?? "")].slice(0, MESSAGE_PREVIEW_LENGTH).join("");

async function thumbOf(
  deps: ChatDeps,
  input: { viewerAccountId: string; ownerAccountId: string; conversationId: string },
): Promise<ConversationThumb | null> {
  if (!deps.media) return null;
  return issueConversationThumb(
    { ...deps.media, db: deps.db, logger: deps.logger, now: deps.now },
    input,
  );
}

async function summaryOf(
  deps: ChatDeps,
  accountId: string,
  row: repo.ConversationRow,
  withThumb = true,
): Promise<ConversationSummary> {
  const { state, closedHow } = stateOf({
    archivedAt: row.archivedAt,
    closedAt: row.closedAt,
    closedHow: row.closedHow,
    counterpartLinked: row.counterpartId !== null,
    blocked: row.blocked,
  });
  // A live account always has its year and month (rule 3); only a tombstone lacks them, and its link is cut.
  const person =
    row.counterpartId !== null &&
    row.counterpartBirthYear !== null &&
    row.counterpartBirthMonth !== null
      ? {
          id: row.counterpartId,
          age: ageInYears(row.counterpartBirthYear, row.counterpartBirthMonth, deps.now()),
        }
      : null;
  return {
    id: row.id,
    state,
    closedHow,
    counterpart: person
      ? {
          deleted: false,
          name: row.counterpartName ?? "",
          age: person.age,
          // The thumb is the card's rule (findMainPhotoOf): none across a block or for
          // somebody not active, and none once the conversation has ended, so a lifted
          // ban never shows as an ended conversation with a photo (ADR-024 §6).
          thumb:
            withThumb && state !== "closed"
              ? await thumbOf(deps, {
                  viewerAccountId: accountId,
                  ownerAccountId: person.id,
                  conversationId: row.id,
                })
              : null,
        }
      : { deleted: true },
    lastMessage: row.last
      ? {
          at: row.last.createdAt.toISOString(),
          kind: row.last.kind,
          preview: preview(row.last.body),
          side: row.last.side === row.side ? "mine" : "theirs",
        }
      : null,
    unread: row.unread,
  };
}

/**
 * The list (#348): open conversations, then the archived and the closed ones,
 * each newest first; without thumbs when the caller only counts (the home
 * screen), so nothing is signed or spent.
 */
export async function listConversations(
  deps: ChatDeps,
  accountId: string,
  options: { thumbs: boolean } = { thumbs: true },
): Promise<ConversationList> {
  const rows = await repo.listConversations(deps.db, accountId, CONVERSATIONS_MAX * 2);
  const summaries: ConversationSummary[] = [];
  for (const row of rows) summaries.push(await summaryOf(deps, accountId, row, options.thumbs));
  return {
    open: summaries.filter((s) => s.state === "open").slice(0, CONVERSATIONS_MAX),
    archived: summaries.filter((s) => s.state !== "open").slice(0, CONVERSATIONS_MAX),
  };
}

const notFound = () => new AppError(404, "not_found", "No such conversation");

/** One conversation, with what the composer needs and how far the other side has read. */
export async function readConversation(
  deps: ChatDeps,
  accountId: string,
  conversationId: string,
): Promise<ConversationDetail> {
  const row = await repo.findConversation(deps.db, accountId, conversationId);
  if (!row) throw notFound();
  const summary = await summaryOf(deps, accountId, row);
  const maxLength = await matchingConfigNumber(deps.db, MESSAGE_MAX_LENGTH_KEY);
  return { ...summary, limits: { maxLength }, counterpartReadUpTo: row.counterpartReadUpTo };
}

/** Whether the caller may read the conversation: theirs, and not hidden from them by their own block. */
export async function requireConversation(
  db: Queryable,
  accountId: string,
  conversationId: string,
): Promise<repo.ConversationRow> {
  const row = await repo.findConversation(db, accountId, conversationId);
  if (!row) throw notFound();
  return row;
}

/**
 * The research event of a close, for the person on the other side from the
 * one acted on, while linked: an erasure or, with #351, an unmatch. Never for
 * the erased person, whose mapping goes in the same transaction; never for a
 * block or a sanction, which would be a block's or a sanction's event under
 * another name (ADR-030 §9, ADR-024); never for a conversation that had
 * closed before. track() checks the consent; nothing of the text.
 */
async function trackClosed(
  deps: { db: Queryable; logger: Logger; now: () => Date },
  closed: repo.Closed[],
): Promise<void> {
  for (const close of closed) {
    if (close.counterpartId === null || !close.closedNow) continue;
    if (close.how !== "erasure" && close.how !== "unmatch") continue;
    await track(deps, close.counterpartId, "conversation_closed", {
      how: close.how,
      messages: messageCountBand(close.messages),
    });
  }
}

/**
 * A ban closes the person's conversations (ADR-024, ADR-031 §2), called in
 * the ban's transaction for every live account of the identity. A suspension
 * closes nothing: its sessions are ended, and the conversations wait. No
 * research event (ADR-024).
 */
export async function closeConversationsOf(
  db: Queryable,
  input: { accountIds: string[]; how: "sanction"; at: Date },
): Promise<number> {
  return (await repo.closeConversationsOf(db, input)).filter((close) => close.closedNow).length;
}

export type ConversationErasure = {
  /** The participant rows whose link was cut. */
  conversations: number;
  /** Messages the counterpart never received (an open shadow ban), deleted. */
  withheld: number;
  /** Conversations nobody is linked to any more, the other person erased before, deleted. */
  emptied: number;
};

/**
 * The chat's part of an erasure (ADR-007 §4, ADR-031 §5), inside its
 * transaction: what the counterpart never received goes while the shadow ban
 * that withheld it is still on record; the person's open and archived
 * conversations close; the person's link is cut. The messages stay for the
 * counterpart, under "Deleted user" (TD-7); a conversation whose counterpart
 * was erased before keeps them for nobody, and goes.
 */
export async function eraseConversationsOf(
  deps: { db: Queryable; logger: Logger; now: () => Date },
  accountId: string,
): Promise<ConversationErasure> {
  const withheld = await repo.deleteWithheldMessagesOf(deps.db, accountId);
  const closed = await repo.closeConversationsOf(deps.db, {
    accountIds: [accountId],
    how: "erasure",
    at: deps.now(),
  });
  const unlinked = await repo.unlinkParticipant(deps.db, accountId);
  const emptied = await repo.deleteUnlinkedConversations(deps.db, unlinked);
  await trackClosed(deps, closed);
  return { conversations: unlinked.length, withheld, emptied };
}

/**
 * The person's conversations for their export (ADR-031 §5): when each opened
 * and how it stands, their own messages with the words, the counterpart's as
 * a time and a length. Nothing names the counterpart.
 */
export async function exportConversations(
  db: Queryable,
  accountId: string,
): Promise<ExportedConversation[]> {
  const rows = await repo.exportConversationsOf(db, accountId);
  return rows.map((row) => {
    const { state, closedHow } = stateOf({
      archivedAt: row.archivedAt,
      closedAt: row.closedAt,
      closedHow: row.closedHow,
      counterpartLinked: row.counterpartLinked,
      blocked: row.blocked,
    });
    return {
      openedAt: row.openedAt.toISOString(),
      state,
      closedHow,
      mine: row.lines
        .filter((line) => line.mine)
        .map((line) => ({ at: line.at.toISOString(), body: line.body ?? "" })),
      theirs: row.lines
        .filter((line) => !line.mine)
        .map((line) => ({ at: line.at.toISOString(), length: line.length })),
    };
  });
}
