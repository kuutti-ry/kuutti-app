import { type Queryable, transaction } from "@kuutti/db";
import type { FoundReason } from "@kuutti/schema";
import { AppError } from "../lib/errors.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import type { Logger } from "../lib/logger.ts";
import { track } from "../research/index.ts";

// "Löysin hänet" (#83, ADR-040): a person tells Kuutti they found somebody,
// and why, from a closed list. It is an indication and nothing more, the
// maintainer's of 21/10/2026: nothing in the app changes, no state, no
// session, no round, no conversation. It feeds the association's one measure
// of success, an anonymous count by Finnish day and reason that names no
// person (found_them_count), so it outlives every erasure. The account keeps
// only that it answered, so each counts once, and never which reason.

export type FoundThemDeps = { db: Queryable; logger: Logger; now: () => Date };

/** Whether the caller has answered; never which reason. */
export async function foundThemAnswered(db: Queryable, accountId: string): Promise<boolean> {
  const { rows } = await db.query<{ answered: boolean }>(
    "SELECT found_them_answered AS answered FROM account WHERE id = $1 AND state <> 'deleted'",
    [accountId],
  );
  const row = rows[0];
  if (!row) throw new AppError(404, "not_found", "No live account");
  return row.answered;
}

/**
 * The answer, once per account, in one transaction under the account row's
 * lock: the flag set and the day's count moved together, so two devices at
 * once count one answer, and an erasure that took the row first leaves
 * nothing counted. Then the research event, for those who said yes to it.
 */
export async function tellFoundThem(
  deps: FoundThemDeps,
  accountId: string,
  reason: FoundReason,
): Promise<void> {
  const at = deps.now();
  await transaction(deps.db, async (tx) => {
    const { rows } = await tx.query<{ answered: boolean }>(
      `SELECT found_them_answered AS answered FROM account
        WHERE id = $1 AND state <> 'deleted' FOR UPDATE`,
      [accountId],
    );
    const row = rows[0];
    if (!row) throw new AppError(404, "not_found", "No live account");
    if (row.answered) {
      throw new AppError(409, "found_them_answered", "This account told Kuutti already");
    }
    await tx.query("UPDATE account SET found_them_answered = true WHERE id = $1", [accountId]);
    await tx.query(
      `INSERT INTO found_them_count (day, reason, count) VALUES ($1, $2, 1)
       ON CONFLICT (day, reason) DO UPDATE SET count = found_them_count.count + 1`,
      [finnishDay(at), reason],
    );
  });
  await track({ ...deps, now: () => at }, accountId, "found_them", { reason });
}

export type FoundThemCounts = { here: number; elsewhere: number; other: number };

/**
 * The anonymous count, by reason: over the `days` Finnish days that end with
 * `today`, or in all. The window is counted in calendar days by the database,
 * never in hours, so a change of the clocks in it moves no day.
 */
export async function foundThemCounts(
  db: Queryable,
  recent?: { today: string; days: number },
): Promise<FoundThemCounts> {
  const { rows } = await db.query<{ reason: FoundReason; n: number }>(
    `SELECT reason, sum(count)::int AS n FROM found_them_count
      WHERE $1::date IS NULL OR day > $1::date - $2::int
      GROUP BY reason`,
    [recent?.today ?? null, recent?.days ?? 0],
  );
  const counts: FoundThemCounts = { here: 0, elsewhere: 0, other: 0 };
  for (const row of rows) counts[row.reason] = row.n;
  return counts;
}
