import { type Queryable, transaction } from "@kuutti/db";
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
  type ExportedSentPhoto,
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
/** The days after a close during which either person may still report the conversation (#351, ADR-030 §12). */
export const REPORT_AFTER_CLOSE_DAYS_KEY = "report_after_close_days";

const DAY_MS = 86_400_000;

/**
 * Whether a report from the conversation is taken at `at` (#351): while it is
 * open, and for `days` after it closed, so a block cannot be used to dodge a
 * report (ADR-030 §2). A day is 24 hours, as for the reports' own retention.
 */
export function reportWindowHolds(closedAt: Date | null, at: Date, days: number): boolean {
  return closedAt === null || at.getTime() - closedAt.getTime() <= days * DAY_MS;
}

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
export function stateOf(row: {
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
  // An ended conversation names nobody, before and after either person
  // leaves (ADR-031 Open 10): the person blocked never learns of the
  // blocker's erasure from a name that turned into "Deleted user".
  const ended = state === "closed" && closedHow === "unmatch";
  return {
    id: row.id,
    state,
    closedHow,
    counterpart: ended
      ? null
      : person
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
          seq: row.last.seq,
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

/**
 * One conversation, with what the composer needs, how far the other side has
 * read, and the contacts (#103): the caller's stored pieces, each shared here
 * or not, and what the other person shares with them now.
 */
export async function readConversation(
  deps: ChatDeps,
  accountId: string,
  conversationId: string,
): Promise<ConversationDetail> {
  const row = await repo.findConversation(deps.db, accountId, conversationId);
  if (!row) throw notFound();
  const summary = await summaryOf(deps, accountId, row);
  const maxLength = await matchingConfigNumber(deps.db, MESSAGE_MAX_LENGTH_KEY);
  const contacts = await repo.readConversationContacts(deps.db, accountId, conversationId);
  const days = await matchingConfigNumber(deps.db, REPORT_AFTER_CLOSE_DAYS_KEY);
  return {
    ...summary,
    limits: { maxLength },
    counterpartReadUpTo: row.counterpartReadUpTo,
    contacts,
    // Somebody to report, and the window open (ADR-030 §12).
    reportable: row.counterpartId !== null && reportWindowHolds(row.closedAt, deps.now(), days),
  };
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
 * the ban's transaction for every live account of the identity, and ends
 * what either person shared in them (#103). A suspension closes nothing: its
 * sessions are ended, and the conversations wait. No research event
 * (ADR-024).
 */
export async function closeConversationsOf(
  db: Queryable,
  input: { accountIds: string[]; how: "sanction"; at: Date },
): Promise<number> {
  return (await repo.closeConversationsOf(db, input)).filter((close) => close.closedNow).length;
}

/**
 * An unmatch (#351): the caller ends the conversation for both, blocking
 * nobody. Both read it as ended, "This conversation has ended", with nothing
 * saying who ended it or how, and both may still report it for
 * report_after_close_days. What either shared there ends with it (#103); the
 * other person is told by the socket (#349, migration 0055's trigger). One
 * already closed stays as it is, and the answer is the same. Not the caller's,
 * or hidden from them as its blocker: 404.
 */
export async function unmatchConversation(
  deps: { db: Queryable; logger: Logger; now: () => Date },
  accountId: string,
  conversationId: string,
): Promise<void> {
  await transaction(deps.db, async (tx) => {
    // The send's order (ADR-031 §3): the account held in a live state, the
    // conversation locked through the caller's row, then what it decides on.
    if (!(await repo.holdLiveAccount(tx, accountId))) throw notFound();
    if (!(await repo.lockConversation(tx, accountId, conversationId))) throw notFound();
    const state = await repo.readSendState(tx, accountId, conversationId);
    if (!state || state.hidden) throw notFound();
    const closed = await repo.closeConversationsOf(tx, {
      accountIds: [accountId],
      how: "unmatch",
      at: deps.now(),
      conversationId,
    });
    await trackClosed({ ...deps, db: tx }, closed);
  });
}

/**
 * A block's close (#351, ADR-030 §2): every conversation between the two
 * accounts closes as the block's, written by the safety slice in the block's
 * transaction, so the row's lock puts it in one order with a send in flight,
 * and its blocker never sees them again, even after the other's erasure. One
 * closed before for another reason is written as the block's too. No research
 * event (ADR-030 §9). The number closed now.
 */
export async function closeConversationsBetween(
  db: Queryable,
  input: { blockerAccountId: string; blockedAccountId: string; at: Date },
): Promise<number> {
  const closed = await repo.closeConversationsOf(db, {
    accountIds: [input.blockerAccountId],
    how: "block",
    at: input.at,
    counterpartId: input.blockedAccountId,
  });
  return closed.filter((close) => close.closedNow).length;
}

/**
 * The conversation between two people, in any state, or null: the match's
 * record (ADR-031), so two people who have one are matched, or were (#100).
 */
export async function conversationBetween(
  db: Queryable,
  accountId: string,
  otherAccountId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT mine.conversation_id AS id
       FROM conversation_participant mine
       JOIN conversation_participant other
         ON other.conversation_id = mine.conversation_id AND other.side <> mine.side
      WHERE mine.account_id = $1 AND other.account_id = $2
      ORDER BY mine.joined_at LIMIT 1`,
    [accountId, otherAccountId],
  );
  return rows[0]?.id ?? null;
}

/**
 * The match's conversation (#100, ADR-031 §2, ADR-038), written in the
 * statement of the second like and inside its transaction, the earlier liker
 * on side a. The caller holds the pair's lock and has asked that none
 * stands between the two. No trigger announces it (migration 0055 notifies
 * on updates and messages, not on this insert): the other person sees it at
 * their next read of the list (ADR-038 §1, Open 1).
 */
export async function openConversation(
  tx: Queryable,
  input: { first: string; second: string; at: Date },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    "INSERT INTO conversation (opened_at) VALUES ($1) RETURNING id",
    [input.at],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("conversation not written");
  await tx.query(
    `INSERT INTO conversation_participant (conversation_id, account_id, side, joined_at)
     VALUES ($1, $2, 'a', $4), ($1, $3, 'b', $4)`,
    [id, input.first, input.second, input.at],
  );
  return id;
}

/**
 * The conversation a report or a block names (#351), its row locked until the
 * caller's transaction ends, read through the caller's own participant row:
 * null when it is not theirs.
 */
export async function lockReportedConversation(
  db: Queryable,
  accountId: string,
  conversationId: string,
): Promise<repo.ReportedConversation | null> {
  return repo.lockForReport(db, accountId, conversationId);
}

/**
 * Whether a line of the conversation is a photo the other person sent that
 * the caller may read (#476, ADR-030 §13): the one a report may point at.
 * Through the caller's own participant row and every rule of the reads, so a
 * line a shadow ban withholds from the caller, the caller's own, a text and a
 * photo gone are all no, and the answer never tells which.
 */
export async function counterpartPhotoAt(
  db: Queryable,
  input: { accountId: string; conversationId: string; seq: number },
): Promise<boolean> {
  const found = await repo.messageFor(db, input);
  return found !== null && found.row.side !== found.side && found.row.photo !== null;
}

/**
 * A report's frozen copy of a conversation the caller locked (#351, ADR-030
 * §12): every message of both people, into the report the caller just wrote,
 * inside its transaction; the words never pass through the process. The
 * number of lines.
 */
export async function copyConversation(
  db: Queryable,
  input: { accountId: string; conversationId: string; reportId: string },
): Promise<number> {
  return repo.copyConversation(db, input);
}

export type ConversationErasure = {
  /** The participant rows whose link was cut. */
  conversations: number;
  /** Messages the counterpart never received (an open shadow ban), deleted. */
  withheld: number;
  /** Conversations nobody is linked to any more, the other person erased before, deleted. */
  emptied: number;
  /** The person's stored contacts (#103), deleted; their shares stay as the record, ended by the close. */
  contacts: number;
};

/**
 * The chat's part of an erasure (ADR-007 §4, ADR-031 §5), inside its
 * transaction: what the counterpart never received goes while the shadow ban
 * that withheld it is still on record; the person's open and archived
 * conversations close, which ends what either person shared there (#103);
 * the person's stored contacts go; the person's link is cut. The messages
 * stay for the counterpart, under "Deleted user" (TD-7), and the shares as
 * the record, with no value in them; a conversation whose counterpart was
 * erased before keeps them for nobody, and goes, its shares with it.
 */
export async function eraseConversationsOf(
  deps: { db: Queryable; logger: Logger; now: () => Date },
  accountId: string,
): Promise<ConversationErasure> {
  const withheld = await repo.deleteWithheldMessagesOf(deps.db, accountId);
  // A photo a report's copy holds outlives the erasure (#351), but not in the
  // conversation: it reads "Photo removed" there, as any of the person's photos.
  await repo.detachPhotosOf(deps.db, accountId);
  const closed = await repo.closeConversationsOf(deps.db, {
    accountIds: [accountId],
    how: "erasure",
    at: deps.now(),
  });
  const contacts = await repo.deleteContactsOf(deps.db, accountId);
  const unlinked = await repo.unlinkParticipant(deps.db, accountId);
  const emptied = await repo.deleteUnlinkedConversations(deps.db, unlinked);
  await trackClosed(deps, closed);
  return { conversations: unlinked.length, withheld, emptied, contacts };
}

/**
 * The person's conversations for their export (ADR-031 §5): when each opened
 * and how it stands, their own messages with the words, the counterpart's as
 * a time and a length, and the person's own shares of a contact (#103) as
 * the record, never a value. Nothing names the counterpart.
 */
export async function exportConversations(
  db: Queryable,
  accountId: string,
  /** A sent photo's entry by its id (#350), from the media slice's export; null when it has none. */
  sentPhoto: (photoId: string) => ExportedSentPhoto | null,
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
        .map((line) => ({
          at: line.at.toISOString(),
          kind: line.kind,
          body: line.body ?? "",
          photo: line.photoId ? sentPhoto(line.photoId) : null,
        })),
      shares: row.shares.map((share) => ({
        kind: share.kind,
        sharedAt: share.sharedAt.toISOString(),
        endedAt: share.endedAt?.toISOString() ?? null,
        endedHow: share.endedHow,
      })),
      theirs: row.lines
        .filter((line) => !line.mine)
        .map((line) => ({ at: line.at.toISOString(), kind: line.kind, length: line.length })),
    };
  });
}
