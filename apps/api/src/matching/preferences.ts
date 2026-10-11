import { type Queryable, transaction } from "@kuutti/db";
import {
  AgeWindow,
  Gender,
  type PreferencesResponse,
  type PreferencesUpdate,
} from "@kuutti/schema";
import { z } from "zod";
import { AppError } from "../lib/errors.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import { admissionAnew } from "../pond/index.ts";

// Raw parameterised SQL for the same reason as identity/repo.ts: Deps.db is
// the Queryable seam the test harness hands a rolled-back transaction through.
// preferences(account_id, field, value, mode, include_unknown), rules/db.md:
// one row per field, deal-breakers are mode = hard. Onboarding (#46) writes
// the two hard rows nothing can start without; the round builder of M4 joins
// both parties' hard rows. Every statement carries the caller's account id
// (rule 6), and no log line here carries seeks (rule 5, checklist line 66).

const SEEKS = "seeks";
const AGE_WINDOW = "age_window";

/** A change of gender or of whom one seeks is possible once in this many days (#147, ADR-015 §9). */
export const CHANGE_CADENCE_KEY = "change_cadence_days";
const DAY_MS = 86_400_000;

/** From when a change made at `changedAt` may be followed by another; null when now. */
export function nextChangeFrom(changedAt: Date | null, cadenceDays: number, at: Date): Date | null {
  if (!changedAt) return null;
  const from = new Date(changedAt.getTime() + cadenceDays * DAY_MS);
  return from.getTime() > at.getTime() ? from : null;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

type Row = { field: string; value: unknown };

/**
 * The two hard rows' stored values as the contract reads them: a value that no
 * longer parses reads as unset. Pure, so a reader of many accounts at once
 * (the waitlist counter, #54) decides exactly as the reader of one.
 */
export function preferencesFrom(values: {
  seeks: unknown;
  ageWindow: unknown;
}): PreferencesResponse {
  return {
    seeks: z.array(Gender).min(1).safeParse(values.seeks).data ?? null,
    ageWindow: AgeWindow.safeParse(values.ageWindow).data ?? null,
  };
}

/** The two hard rows as the person set them; a row that no longer parses reads as unset. */
export async function readPreferences(
  db: Queryable,
  accountId: string,
): Promise<PreferencesResponse> {
  const { rows } = await db.query<Row>(
    `SELECT field, value FROM preferences
     WHERE account_id = $1 AND mode = 'hard' AND field IN ($2, $3)`,
    [accountId, SEEKS, AGE_WINDOW],
  );
  const byField = new Map(rows.map((r) => [r.field, r.value]));
  return preferencesFrom({ seeks: byField.get(SEEKS), ageWindow: byField.get(AGE_WINDOW) });
}

/**
 * The rows the update names, each written or replaced; the other stays as it
 * was (ADR-010 §13). A tombstone takes none (#51).
 */
export async function savePreferences(
  db: Queryable,
  accountId: string,
  update: PreferencesUpdate,
  at: Date,
): Promise<boolean> {
  return transaction(db, async (tx) => {
    // The lock erasure takes first (ADR-009 §8): a save racing an erasure
    // lands before the deletes or sees the tombstone and writes nothing.
    const live = await tx.query<{ gender: string | null; seeks_changed_at: Date | null }>(
      "SELECT gender, seeks_changed_at FROM account WHERE id = $1 AND state <> 'deleted' FOR UPDATE",
      [accountId],
    );
    const account = live.rows[0];
    if (!account) return false;
    const before = await readPreferences(tx, accountId);
    const { seeks, ageWindow } = update;
    // A change of whom one seeks, once in the cadence (#147, ADR-015 §10): a
    // lever on the figures otherwise. The first answer and the same answer
    // again are no change; the window of ages is free. The time lives on the
    // account, which a withdrawn consent does not clear, and an answer after
    // a withdrawal counts as a change while a change is on record: the
    // withdrawal is no way round.
    const change =
      seeks !== undefined &&
      (before.seeks === null ? account.seeks_changed_at !== null : !sameSet(before.seeks, seeks));
    if (change) {
      const cadence = await matchingConfigNumber(tx, CHANGE_CADENCE_KEY);
      const from = nextChangeFrom(account.seeks_changed_at, cadence, at);
      if (from) {
        throw new AppError(429, "change_too_soon", "Whom one seeks was changed recently", {
          from: from.toISOString(),
        });
      }
      await tx.query("UPDATE account SET seeks_changed_at = $2 WHERE id = $1", [accountId, at]);
    }
    const rows = [
      ...(seeks === undefined ? [] : [[SEEKS, seeks] as const]),
      ...(ageWindow === undefined ? [] : [[AGE_WINDOW, ageWindow] as const]),
    ];
    let written = 0;
    for (const [field, value] of rows) {
      const result = await tx.query(
        `INSERT INTO preferences (account_id, field, value, mode, include_unknown, created_at, updated_at)
         SELECT $1, $2, $3::jsonb, 'hard', false, $4, $4
         WHERE EXISTS (SELECT 1 FROM account WHERE id = $1 AND state <> 'deleted')
         ON CONFLICT (account_id, field) DO UPDATE
           SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [accountId, field, JSON.stringify(value), at],
      );
      written += result.rowCount ?? 0;
    }
    // Whom one seeks decides with whom one waits at the pond gate (#94,
    // ADR-015 §9): joining a group that waits is decided anew by the next count.
    if (seeks !== undefined) {
      await admissionAnew(
        tx,
        accountId,
        { gender: account.gender, seeks: before.seeks },
        { gender: account.gender, seeks },
      );
    }
    return written === rows.length;
  });
}

/**
 * Withdrawing the special-category consent takes the seek answer with it
 * (ADR-019 §4, #146): the row goes, the age window stays, and onboarding asks
 * again. The place at the gate follows the change of seeks like any other.
 */
export async function deleteSeeksOfAccount(db: Queryable, accountId: string): Promise<boolean> {
  return transaction(db, async (tx) => {
    const live = await tx.query<{ gender: string | null }>(
      "SELECT gender FROM account WHERE id = $1 AND state <> 'deleted' FOR UPDATE",
      [accountId],
    );
    const account = live.rows[0];
    if (!account) return false;
    const before = await readPreferences(tx, accountId);
    await tx.query("DELETE FROM preferences WHERE account_id = $1 AND field = $2", [
      accountId,
      SEEKS,
    ]);
    await admissionAnew(
      tx,
      accountId,
      { gender: account.gender, seeks: before.seeks },
      { gender: account.gender, seeks: null },
    );
    return true;
  });
}

/** Erasure (TD-7, #51): every preference row of the account. */
export async function deletePreferencesOfAccount(
  db: Queryable,
  accountId: string,
): Promise<number> {
  const result = await db.query("DELETE FROM preferences WHERE account_id = $1", [accountId]);
  return result.rowCount ?? 0;
}
