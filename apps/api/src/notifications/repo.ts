import type { Queryable } from "@kuutti/db";
import type { NoticeKind, NotificationKind, SanctionReason } from "@kuutti/schema";

// The notification choices and the notices (#176, ADR-032). Raw
// parameterised SQL, as in the other slices; every statement names the
// caller's account (rule 6). A warning's notice reads its sanction, the
// safety slice's row, for the reason and whether it was lifted: the notice
// holds nothing of its own.

type Row = Record<string, unknown>;

/** The kinds the person switched, with their state; a kind with no row is on. */
export async function listChoices(
  db: Queryable,
  accountId: string,
): Promise<Array<{ kind: NotificationKind; enabled: boolean }>> {
  const { rows } = await db.query<{ kind: NotificationKind; enabled: boolean }>(
    "SELECT kind, enabled FROM notification_preference WHERE account_id = $1 ORDER BY kind",
    [accountId],
  );
  return rows;
}

/**
 * Sets one kind for a live account; false when the account is erased. The
 * account row is held (FOR SHARE) as every writer holds it, so an erasure
 * under way either finishes first and this writes nothing, or waits for it
 * and deletes what it wrote.
 */
export async function upsertChoice(
  db: Queryable,
  input: { accountId: string; kind: NotificationKind; enabled: boolean; at: Date },
): Promise<boolean> {
  const { rows } = await db.query(
    `INSERT INTO notification_preference (account_id, kind, enabled, updated_at)
     SELECT a.id, $2, $3, $4 FROM account a WHERE a.id = $1 AND a.state <> 'deleted'
     FOR SHARE
     ON CONFLICT (account_id, kind)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at
     RETURNING id`,
    [input.accountId, input.kind, input.enabled, input.at],
  );
  return rows.length > 0;
}

export type NoticeRow = {
  id: string;
  kind: NoticeKind;
  at: Date;
  readAt: Date | null;
  reason: SanctionReason;
};

/** The person's notices, newest first; a warning lifted since is not one any more. */
export async function listNotices(
  db: Queryable,
  accountId: string,
  limit: number,
): Promise<NoticeRow[]> {
  const { rows } = await db.query<Row>(
    `SELECT n.id, n.kind, n.created_at, n.read_at, s.reason
     FROM notice n JOIN sanction s ON s.id = n.sanction_id
     WHERE n.account_id = $1 AND s.lifted_at IS NULL
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT $2`,
    [accountId, limit],
  );
  return rows.map((r) => ({
    id: r.id as string,
    kind: r.kind as NoticeKind,
    at: r.created_at as Date,
    readAt: (r.read_at as Date | null) ?? null,
    reason: r.reason as SanctionReason,
  }));
}

/** Marks one of the caller's notices read, once; false when it is not theirs. */
export async function markRead(
  db: Queryable,
  input: { accountId: string; noticeId: string; at: Date },
): Promise<boolean> {
  const result = await db.query(
    "UPDATE notice SET read_at = coalesce(read_at, $3) WHERE id = $2 AND account_id = $1",
    [input.accountId, input.noticeId, input.at],
  );
  return (result.rowCount ?? 0) > 0;
}

/** A warning's notice, in the warning's transaction (ADR-024 §7). */
export async function insertWarningNotice(
  db: Queryable,
  input: { accountId: string; sanctionId: string; at: Date },
): Promise<void> {
  await db.query(
    "INSERT INTO notice (account_id, kind, sanction_id, created_at) VALUES ($1, 'warning', $2, $3)",
    [input.accountId, input.sanctionId, input.at],
  );
}

/** Everything of the person's here, for the export: every notice, lifted warnings' too. */
export async function exportedNotices(
  db: Queryable,
  accountId: string,
): Promise<Array<{ kind: NoticeKind; at: Date; readAt: Date | null }>> {
  const { rows } = await db.query<Row>(
    `SELECT kind, created_at, read_at FROM notice WHERE account_id = $1
     ORDER BY created_at DESC, id DESC LIMIT 1000`,
    [accountId],
  );
  return rows.map((r) => ({
    kind: r.kind as NoticeKind,
    at: r.created_at as Date,
    readAt: (r.read_at as Date | null) ?? null,
  }));
}

/** Erasure (ADR-007 §4): the person's choices and notices go. */
export async function deleteOf(
  db: Queryable,
  accountId: string,
): Promise<{ choices: number; notices: number }> {
  const notices = await db.query("DELETE FROM notice WHERE account_id = $1", [accountId]);
  const choices = await db.query("DELETE FROM notification_preference WHERE account_id = $1", [
    accountId,
  ]);
  return { choices: choices.rowCount ?? 0, notices: notices.rowCount ?? 0 };
}
