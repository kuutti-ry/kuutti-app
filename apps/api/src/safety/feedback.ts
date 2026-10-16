import { type Queryable, transaction } from "@kuutti/db";
import {
  type ExportedFeedback,
  FEEDBACK_KIND_ORDER,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackPlatform,
} from "@kuutti/schema";

/**
 * Feedback from inside the app (#171, ADR-023, features/safety/feedback.feature):
 * a kind, the person's words, and the build the app read. Stored for the
 * moderators' panel and nothing else: the text reaches no log line and no
 * research event. At most matching_config feedback_per_day rows per account
 * and Finnish day, counted in the statement that writes the row under an
 * advisory lock per account (the export's shape, identity/repo.ts). The rows
 * are the person's: in the export, gone with the account.
 */

export const FEEDBACK_PER_DAY_KEY = "feedback_per_day";

export type NewFeedback = {
  accountId: string;
  kind: FeedbackKind;
  text: string;
  appVersion: string;
  platform: FeedbackPlatform;
  locale: string;
  at: Date;
  /** Start of the cap's day; rows from before it do not count. */
  since: Date;
  limit: number;
};

export type FeedbackRecord = {
  /** False for a tombstone: nothing is written. */
  live: boolean;
  /** Rows written since `since` before this one. */
  used: number;
  /** The row's id, or null when the cap refused it. */
  id: string | null;
};

/** One row under the day's cap: the count and the insert in one statement, so two sends cannot both pass a separate count. */
export async function recordFeedback(db: Queryable, input: NewFeedback): Promise<FeedbackRecord> {
  return transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`feedback:${input.accountId}`]);
    const { rows } = await tx.query<{ live: boolean; used: number; id: string | null }>(
      `WITH live AS (SELECT 1 FROM account WHERE id = $1 AND state <> 'deleted'),
          used AS (SELECT count(*)::int AS n FROM feedback WHERE account_id = $1 AND created_at >= $8),
          ins AS (INSERT INTO feedback (account_id, kind, text, app_version, platform, locale, created_at)
                  SELECT $1, $2::feedback_kind, $3, $4, $5::feedback_platform, $6, $7
                  FROM live, used WHERE used.n < $9
                  RETURNING id)
       SELECT EXISTS (SELECT 1 FROM live) AS live,
              (SELECT n FROM used) AS used,
              (SELECT id FROM ins) AS id`,
      [
        input.accountId,
        input.kind,
        input.text,
        input.appVersion,
        input.platform,
        input.locale,
        input.at,
        input.since,
        input.limit,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("feedback insert returned no row");
    return { live: row.live, used: row.used, id: row.id };
  });
}

type FeedbackRow = {
  id: string;
  account_id: string;
  kind: FeedbackKind;
  text: string;
  app_version: string;
  platform: FeedbackPlatform;
  locale: string;
  created_at: Date;
  handled_at: Date | null;
};

const COLUMNS = "id, account_id, kind, text, app_version, platform, locale, created_at, handled_at";

const toItem = (row: FeedbackRow): FeedbackItem => ({
  id: row.id,
  accountId: row.account_id,
  kind: row.kind,
  text: row.text,
  appVersion: row.app_version,
  platform: row.platform,
  locale: row.locale,
  createdAt: row.created_at.toISOString(),
  handledAt: row.handled_at?.toISOString() ?? null,
});

/** What waits for a moderator: the unhandled rows, a bug first and praise last, the oldest first within a kind. */
export async function listUnhandledFeedback(
  db: Queryable,
  limit: number,
): Promise<{ items: FeedbackItem[]; total: number }> {
  const { rows } = await db.query<FeedbackRow>(
    `SELECT ${COLUMNS} FROM feedback WHERE handled_at IS NULL
     ORDER BY array_position($1::feedback_kind[], kind), created_at, id
     LIMIT $2`,
    [[...FEEDBACK_KIND_ORDER], limit],
  );
  const total = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM feedback WHERE handled_at IS NULL",
  );
  return { items: rows.map(toItem), total: total.rows[0]?.n ?? 0 };
}

/** What waits in the feedback for the front page (#303): how many, and since when the oldest. */
export async function feedbackSummary(
  db: Queryable,
): Promise<{ waiting: number; oldestSince: Date | null }> {
  const { rows } = await db.query<{ n: number; oldest: Date | null }>(
    "SELECT count(*)::int AS n, min(created_at) AS oldest FROM feedback WHERE handled_at IS NULL",
  );
  return { waiting: rows[0]?.n ?? 0, oldestSince: rows[0]?.oldest ?? null };
}

export async function findFeedback(db: Queryable, id: string): Promise<FeedbackItem | null> {
  const { rows } = await db.query<FeedbackRow>(`SELECT ${COLUMNS} FROM feedback WHERE id = $1`, [
    id,
  ]);
  const row = rows[0];
  return row ? toItem(row) : null;
}

/** A moderator read it, once: null when the row is gone or already marked. */
export async function markFeedbackHandled(
  db: Queryable,
  input: { id: string; identityId: string; at: Date },
): Promise<Date | null> {
  const { rows } = await db.query<{ handled_at: Date }>(
    `UPDATE feedback SET handled_at = $2, handled_by = $3
     WHERE id = $1 AND handled_at IS NULL
     RETURNING handled_at`,
    [input.id, input.at, input.identityId],
  );
  return rows[0]?.handled_at ?? null;
}

/** The person's own feedback for the export (ADR-007 §4), newest first, with whether a moderator has read it. */
export async function listFeedbackOfAccount(
  db: Queryable,
  accountId: string,
  limit: number,
): Promise<ExportedFeedback[]> {
  const { rows } = await db.query<FeedbackRow>(
    `SELECT ${COLUMNS} FROM feedback WHERE account_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [accountId, limit],
  );
  return rows.map((row) => ({
    at: row.created_at.toISOString(),
    kind: row.kind,
    text: row.text,
    appVersion: row.app_version,
    platform: row.platform,
    locale: row.locale,
    handledAt: row.handled_at?.toISOString() ?? null,
  }));
}

/** Erasure (ADR-023 §4): the rows go with the account, inside the caller's transaction. */
export async function deleteFeedbackOfAccount(db: Queryable, accountId: string): Promise<number> {
  const result = await db.query("DELETE FROM feedback WHERE account_id = $1", [accountId]);
  return result.rowCount ?? 0;
}
