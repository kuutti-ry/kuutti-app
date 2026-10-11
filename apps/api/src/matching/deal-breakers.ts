import { type Queryable, transaction } from "@kuutti/db";
import {
  DEAL_BREAKER_FIELDS,
  DEAL_BREAKERS_CAP,
  type DealBreaker,
  type DealBreakersUpdate,
  PROFILE_FIELDS,
  type StoredDealBreaker,
} from "@kuutti/schema";
import { z } from "zod";
import { AppError } from "../lib/errors.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";

// Deal-breakers (#149, TD-16, the field sheet's disclose-to-filter rule):
// hard rows of `preferences` on a whitelisted field, beside the two rows of
// onboarding. Raw parameterised SQL for the same reason as preferences.ts;
// every statement carries the caller's account id (rule 6), and no log line
// here carries a value. What the person has answered themselves comes from
// the profile slice through the route's reader, so this slice reads no
// table of another.

export const DEAL_BREAKERS_MAX_KEY = "deal_breakers_max";

/** The caller's own answers, by field key; the route hands it in from the profile slice. */
export type OwnFieldsReader = (accountId: string) => Promise<Record<string, unknown>>;

const WHITELIST = DEAL_BREAKER_FIELDS as readonly string[];
const Accept = z.array(z.string());

/** How many a person may have: the tunable, bounded by the contract's ceiling so a larger row never breaks a client. */
export async function dealBreakersMax(db: Queryable): Promise<number> {
  return Math.min(await matchingConfigNumber(db, DEAL_BREAKERS_MAX_KEY), DEAL_BREAKERS_CAP);
}

const optionsOf = (field: DealBreaker["field"]): readonly string[] => {
  const spec = PROFILE_FIELDS[field];
  return spec.kind === "single" || spec.kind === "multi" ? spec.options : [];
};

/** A filter waits while the person's own answer on its field is missing: read, never stored. */
export const pausedOf = (field: string, own: Record<string, unknown>): boolean =>
  own[field] === undefined;

/** The first accepted answer that is no option of the field, or null when every one is. */
export function invalidAccept(dealBreaker: DealBreaker): string | null {
  const options = optionsOf(dealBreaker.field);
  return dealBreaker.accept.find((option) => !options.includes(option)) ?? null;
}

/** The caller's own deal-breakers, with each one's pause read off the own answers. */
export async function readDealBreakers(
  db: Queryable,
  accountId: string,
  own: Record<string, unknown>,
): Promise<StoredDealBreaker[]> {
  const { rows } = await db.query<{ field: string; value: unknown; include_unknown: boolean }>(
    `SELECT field, value, include_unknown FROM preferences
     WHERE account_id = $1 AND mode = 'hard' AND field = ANY($2::text[])
     ORDER BY field`,
    [accountId, WHITELIST],
  );
  const out: StoredDealBreaker[] = [];
  for (const row of rows) {
    // A field that left the whitelist reads as none; so does an option that
    // left the registry (ADR-009 §1), and a row with no option left: the next
    // save removes it, since it is not in the set sent.
    if (!WHITELIST.includes(row.field)) continue;
    const field = row.field as DealBreaker["field"];
    const options = optionsOf(field);
    const accept = (Accept.safeParse(row.value).data ?? []).filter((o) => options.includes(o));
    if (accept.length === 0) continue;
    out.push({
      field,
      accept,
      includeUnknown: row.include_unknown,
      paused: pausedOf(row.field, own),
    });
  }
  return out;
}

/**
 * The whole set, replaced: at most `max`, each on a distinct whitelisted
 * field the person has answered, accepting options the field has. A filter
 * on what the person will not say about themselves is refused as
 * `filter_unanswered`, with the field, so the screen can ask for the answer
 * instead. Nothing of onboarding's two rows is touched.
 */
export async function saveDealBreakers(
  db: Queryable,
  accountId: string,
  update: DealBreakersUpdate,
  own: Record<string, unknown>,
  max: number,
  at: Date,
): Promise<boolean> {
  if (update.dealBreakers.length > max) {
    throw new AppError(400, "validation_failed", "More deal-breakers than allowed", { max });
  }
  const fields = update.dealBreakers.map((d) => d.field);
  if (new Set(fields).size !== fields.length) {
    throw new AppError(400, "validation_failed", "A field at most once");
  }
  for (const dealBreaker of update.dealBreakers) {
    const unknown = invalidAccept(dealBreaker);
    if (unknown !== null) {
      throw new AppError(400, "validation_failed", "Not an option of the field", {
        field: dealBreaker.field,
      });
    }
    if (pausedOf(dealBreaker.field, own)) {
      throw new AppError(409, "filter_unanswered", "Answer the field yourself first", {
        field: dealBreaker.field,
      });
    }
  }
  return transaction(db, async (tx) => {
    // The lock erasure takes first (ADR-009 §8): a save racing an erasure
    // lands before the deletes or sees the tombstone and writes nothing.
    const live = await tx.query(
      "SELECT 1 FROM account WHERE id = $1 AND state <> 'deleted' FOR UPDATE",
      [accountId],
    );
    if (live.rows.length === 0) return false;
    await tx.query(
      `DELETE FROM preferences
       WHERE account_id = $1 AND field = ANY($2::text[]) AND NOT (field = ANY($3::text[]))`,
      [accountId, WHITELIST, fields],
    );
    for (const dealBreaker of update.dealBreakers) {
      await tx.query(
        `INSERT INTO preferences (account_id, field, value, mode, include_unknown, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, 'hard', $4, $5, $5)
         ON CONFLICT (account_id, field) DO UPDATE
           SET value = EXCLUDED.value, include_unknown = EXCLUDED.include_unknown,
               updated_at = EXCLUDED.updated_at`,
        [
          accountId,
          dealBreaker.field,
          JSON.stringify(dealBreaker.accept),
          dealBreaker.includeUnknown,
          at,
        ],
      );
    }
    return true;
  });
}
