import { type Queryable, transaction } from "@kuutti/db";
import type { ReportOutcome, SanctionReason } from "@kuutti/schema";
import { lockReportedConversation, reportWindowHolds, threadForReport } from "../chat/index.ts";
import type { Logger } from "../lib/logger.ts";
import {
  deleteOrphanedObjects,
  eraseReleasedPhotos,
  type MediaStore,
  wasShown,
} from "../media/index.ts";
import { blockStandsBetween, insertBlock } from "./blocks.ts";

/**
 * Reports (#84, ADR-030, features/safety/reports.feature): a person tells the
 * moderators about somebody whose card they were shown, or the other person
 * of a conversation with a frozen copy of it (#351, ADR-030 §12), with a reason of
 * #106's list and, if they like, a few lines; the report blocks both ways in
 * the same transaction. The reported person learns nothing. The note reaches
 * no log line, error detail or research event (rule 5). At most
 * matching_config reports_per_day per account and Finnish day, counted under
 * an advisory lock per account (the feedback's lock); one open report per
 * pair. Both are asked before the card is, so neither answer tells whether
 * the other person, or their photos, are still there. The moderators read and
 * decide them in the panel (#311, #312). Kept twelve months from filing,
 * whoever of the two is erased meanwhile; the night prunes the rest.
 */

export const REPORTS_PER_DAY_KEY = "reports_per_day";

/** Twelve months (TD-7's report snapshots, rules/db.md); the nightly prune keeps it. */
export const REPORT_RETENTION_DAYS = 365;

/** A day here is 24 hours, in SQL as in JS, as for the photo check's notes. */
const DAY_MS = 86_400_000;

export type NewReport = {
  reporterAccountId: string;
  reportedAccountId: string;
  reason: SanctionReason;
  note: string | null;
  at: Date;
  /** Start of the cap's day; rows from before it do not count. */
  since: Date;
  limit: number;
};

export type ReportRecord =
  /** Filed, and the block with it. */
  | { outcome: "filed" }
  /** One is open for the pair already: nothing written, nothing counted. */
  | { outcome: "open" }
  /** Over the day's cap: nothing written, the block neither. */
  | { outcome: "over_budget"; used: number }
  /** Never shown, oneself, nobody, a later account of somebody blocked, or the caller erased: nothing written. */
  | { outcome: "not_found" };

/**
 * The report and its block in one transaction. The reporter's row is held
 * (`FOR SHARE`, as every writer takes it) so an erasure either finishes first
 * and nothing is written, or waits until both rows are; every report of the
 * reporter's is written under their advisory lock, so two at once cannot both
 * pass the day's count. An open report and the cap answer before the proof of
 * contact (ADR-030 §6): the same answer whoever is named. The proof is a
 * block that stands between the two, set while both accounts existed, or a
 * card shown: so a blocked person can report the one who blocked them, and a
 * report decided and asked again is filed again, whether or not the other is
 * still there.
 */
export async function recordReport(db: Queryable, input: NewReport): Promise<ReportRecord> {
  return transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `report:${input.reporterAccountId}`,
    ]);
    const live = await tx.query(
      "SELECT 1 FROM account WHERE id = $1 AND state <> 'deleted' FOR SHARE",
      [input.reporterAccountId],
    );
    if (live.rows.length === 0) return { outcome: "not_found" };
    const { rows } = await tx.query<{ open: boolean; used: number }>(
      `SELECT EXISTS (SELECT 1 FROM report WHERE reporter_account_id = $1
                        AND reported_account_id = $2 AND decided_at IS NULL) AS open,
              (SELECT count(*)::int FROM report
               WHERE reporter_account_id = $1 AND created_at >= $3) AS used`,
      [input.reporterAccountId, input.reportedAccountId, input.since],
    );
    const row = rows[0];
    if (!row) throw new Error("report count returned no row");
    if (row.open) return { outcome: "open" };
    if (row.used >= input.limit) return { outcome: "over_budget", used: row.used };
    // Proof of contact: a block that stands between the two (a report blocks
    // too, so a report decided and asked again finds one), else a card shown.
    const proven =
      (await blockStandsBetween(tx, {
        callerAccountId: input.reporterAccountId,
        otherAccountId: input.reportedAccountId,
      })) ||
      (await wasShown(tx, {
        viewerAccountId: input.reporterAccountId,
        subjectAccountId: input.reportedAccountId,
      }));
    if (!proven) return { outcome: "not_found" };
    await tx.query(
      `INSERT INTO report (reporter_account_id, reported_account_id, source, reason, note, created_at)
       VALUES ($1, $2, 'card', $3::sanction_reason, $4, $5)`,
      [input.reporterAccountId, input.reportedAccountId, input.reason, input.note, input.at],
    );
    // The reporter's row is held above, so the block finds them live.
    await insertBlock(tx, {
      blockerAccountId: input.reporterAccountId,
      blockedAccountId: input.reportedAccountId,
      at: input.at,
    });
    return { outcome: "filed" };
  });
}

export type NewConversationReport = {
  reporterAccountId: string;
  conversationId: string;
  reason: SanctionReason;
  note: string | null;
  at: Date;
  /** Start of the cap's day; rows from before it do not count. */
  since: Date;
  limit: number;
  /** matching_config report_after_close_days. */
  afterCloseDays: number;
};

export type ConversationReportRecord =
  | ReportRecord
  /** Closed longer ago than the window, or the other person erased: nothing written. */
  | { outcome: "window_closed" };

/**
 * A report from a conversation (#351, ADR-030 §12): of its other person,
 * whom the conversation names, so it is its own proof of contact. In one
 * transaction, under the reporter's lock and with their row held as a card's
 * report takes them: the conversation's row locked through the reporter's own
 * participant row, the report naming it, the copy of every message it holds
 * then, both people's (the frozen copy the moderators read, #312), and the
 * block, which closes the conversation (insertBlock). Taken while it is open
 * or archived, and for `afterCloseDays` after it closed, so the person blocked
 * keeps a way to report what was said before the block (ADR-030 §2). A
 * conversation hidden from its blocker is gone (`not_found`), unless the
 * caller's own report of that person is still open, which answers as a
 * repeat does (`open`): the report blocked them, and a resend after a lost
 * answer must not read as a failure. The open report and the day's cap
 * answer as from a card.
 */
export async function recordConversationReport(
  db: Queryable,
  input: NewConversationReport,
): Promise<ConversationReportRecord> {
  return transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `report:${input.reporterAccountId}`,
    ]);
    const live = await tx.query(
      "SELECT 1 FROM account WHERE id = $1 AND state <> 'deleted' FOR SHARE",
      [input.reporterAccountId],
    );
    if (live.rows.length === 0) return { outcome: "not_found" };
    const found = await lockReportedConversation(tx, input.reporterAccountId, input.conversationId);
    if (!found) return { outcome: "not_found" };
    const reported = found.counterpartId;
    if (found.hidden) {
      // By the conversation, not the person: the person's erasure cuts the
      // link, and the answer must not change with it (ADR-030 §6).
      const open = await openReportFrom(tx, input.reporterAccountId, input.conversationId);
      return { outcome: open ? "open" : "not_found" };
    }
    if (reported === null || !reportWindowHolds(found.closedAt, input.at, input.afterCloseDays)) {
      return { outcome: "window_closed" };
    }
    const { rows } = await tx.query<{ open: boolean; used: number }>(
      `SELECT EXISTS (SELECT 1 FROM report WHERE reporter_account_id = $1
                        AND reported_account_id = $2 AND decided_at IS NULL) AS open,
              (SELECT count(*)::int FROM report
               WHERE reporter_account_id = $1 AND created_at >= $3) AS used`,
      [input.reporterAccountId, reported, input.since],
    );
    const row = rows[0];
    if (!row) throw new Error("report count returned no row");
    if (row.open) return { outcome: "open" };
    if (row.used >= input.limit) return { outcome: "over_budget", used: row.used };
    const filed = await tx.query<{ id: string }>(
      `INSERT INTO report (reporter_account_id, reported_account_id, source, reason, note,
                           created_at, conversation_id)
       VALUES ($1, $2, 'conversation', $3::sanction_reason, $4, $5, $6)
       RETURNING id`,
      [input.reporterAccountId, reported, input.reason, input.note, input.at, input.conversationId],
    );
    const reportId = filed.rows[0]?.id;
    if (!reportId) throw new Error("report insert returned no row");
    await copyThread(tx, {
      reportId,
      thread: await threadForReport(tx, input.reporterAccountId, input.conversationId),
    });
    await insertBlock(tx, {
      blockerAccountId: input.reporterAccountId,
      blockedAccountId: reported,
      at: input.at,
    });
    return { outcome: "filed" };
  });
}

/** The caller's own report from this conversation, still waiting for a moderator. */
async function openReportFrom(
  db: Queryable,
  reporterAccountId: string,
  conversationId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM report WHERE reporter_account_id = $1 AND conversation_id = $2
       AND decided_at IS NULL`,
    [reporterAccountId, conversationId],
  );
  return rows.length > 0;
}

/** The frozen copy, one statement for the whole thread; each line's side seen from the report. */
async function copyThread(
  db: Queryable,
  input: {
    reportId: string;
    thread: Awaited<ReturnType<typeof threadForReport>>;
  },
): Promise<void> {
  if (input.thread.length === 0) return;
  const { thread } = input;
  await db.query(
    `INSERT INTO report_message (report_id, seq, side, kind, body, photo_id, created_at)
     SELECT $1, t.seq, t.side::report_message_side, t.kind::message_kind, t.body, t.photo_id, t.created_at
     FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::uuid[], $7::timestamptz[])
       AS t(seq, side, kind, body, photo_id, created_at)`,
    [
      input.reportId,
      thread.map((m) => m.seq),
      thread.map((m) => (m.mine ? "reporter" : "reported")),
      thread.map((m) => m.kind),
      thread.map((m) => m.body),
      thread.map((m) => m.photoId),
      thread.map((m) => m.createdAt),
    ],
  );
}

/**
 * The person's photos that a report's frozen copy holds (#351): erasure
 * keeps them (`erasePhotosOfAccount`'s `keep`) for as long as a copy names
 * them, and the night's prune lets them go with the last such copy. Whoever
 * filed the report: the copy holds the reporter's own lines as well.
 */
export async function photosHeldByReports(db: Queryable, accountId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT DISTINCT p.id FROM photo p
     JOIN report_message rm ON rm.photo_id = p.id
     WHERE p.account_id = $1`,
    [accountId],
  );
  return rows.map((r) => r.id);
}

export type FiledReport = {
  at: Date;
  reason: SanctionReason;
  note: string | null;
  outcome: ReportOutcome | null;
  decidedAt: Date | null;
};

/**
 * The reports the person filed, for their export (ADR-030 §8), newest first:
 * when, why, their own words and what came of it, never whom. From this
 * account or an earlier one of the same identity, the blocks' scope: both
 * are kept through an erasure, so both are the person's to read after
 * coming back. A report about the person is not theirs to read here
 * (ADR-024 §8's reasoning, GDPR Art. 15(4)). Scoped by the caller's account
 * (rule 6).
 */
export async function listReportsOfAccount(
  db: Queryable,
  accountId: string,
  limit: number,
): Promise<FiledReport[]> {
  const { rows } = await db.query<{
    created_at: Date;
    reason: SanctionReason;
    note: string | null;
    outcome: ReportOutcome | null;
    decided_at: Date | null;
  }>(
    `SELECT r.created_at, r.reason, r.note, r.outcome, r.decided_at FROM report r
     JOIN account filer ON filer.id = r.reporter_account_id
     JOIN account me ON me.identity_id = filer.identity_id
     WHERE me.id = $1
     ORDER BY r.created_at DESC, r.id DESC LIMIT $2`,
    [accountId, limit],
  );
  return rows.map((row) => ({
    at: row.created_at,
    reason: row.reason,
    note: row.note,
    outcome: row.outcome,
    decidedAt: row.decided_at,
  }));
}

export type PrunedReports = {
  pruned: number;
  /** Photos of erased senders that only the pruned copies held (#351), deleted. */
  photos: number;
  /** Their objects no other row shares, deleted after the commit. */
  objects: number;
};

/**
 * The nightly prune: a report filed more than twelve months ago goes, open or
 * decided, with its frozen copy; its block stays. Then every photo of an
 * erased sender that no copy holds any more goes, through the media slice's
 * own erasure (#351), and its objects once nothing else shares them, after
 * the commit as an erasure deletes them; a living sender's photo stays
 * theirs. A sweep rather than the photos of tonight's reports alone: erasure
 * deletes every photo it does not hold, so one left on an erased account is
 * one a copy held, and an erasure that held a photo while tonight's prune let
 * its last copy go is caught the next night.
 */
export async function pruneReports(
  deps: { db: Queryable; logger: Logger; store?: MediaStore },
  now: Date,
): Promise<PrunedReports> {
  const { pruned, keys } = await transaction(deps.db, async (tx) => {
    const gone = await tx.query("DELETE FROM report WHERE created_at < $1", [
      new Date(now.getTime() - REPORT_RETENTION_DAYS * DAY_MS),
    ]);
    // The copies went with their reports (cascade); a photo a copy still names stays.
    const { rows } = await tx.query<{ id: string }>(
      `SELECT p.id FROM photo p JOIN account a ON a.id = p.account_id
       WHERE a.state = 'deleted' AND p.purpose = 'message'
         AND NOT EXISTS (SELECT 1 FROM report_message rm WHERE rm.photo_id = p.id)`,
    );
    const released = rows.map((row) => row.id);
    return { pruned: gone.rowCount ?? 0, keys: await eraseReleasedPhotos(tx, released) };
  });
  const objects = deps.store
    ? await deleteOrphanedObjects({ db: deps.db, store: deps.store, logger: deps.logger }, keys, {
        job: "prune-reports",
      })
    : 0;
  return { pruned, photos: keys.length, objects };
}
