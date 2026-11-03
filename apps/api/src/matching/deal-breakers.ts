import { type Queryable, transaction } from "@kuutti/db";
import {
  DEAL_BREAKERS_CAP,
  type DealBreaker,
  DealBreakerField,
  type DealBreakersUpdate,
  DISTANCE_FILTER_BANDS,
  dealBreakerOptions,
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

const DEAL_BREAKERS_MAX_KEY = "deal_breakers_max";

/** The caller's own answers, by field key; the route hands it in from the profile slice. */
export type OwnFieldsReader = (accountId: string) => Promise<Record<string, unknown>>;

const WHITELIST: readonly string[] = DealBreakerField.options;
const Accept = z.array(z.string());

/** How many a person may have: the tunable, bounded by the contract's ceiling so a larger row never breaks a client. */
export async function dealBreakersMax(db: Queryable): Promise<number> {
  return Math.min(await matchingConfigNumber(db, DEAL_BREAKERS_MAX_KEY), DEAL_BREAKERS_CAP);
}

/**
 * A filter waits while the person's own answer on its field is missing: read,
 * never stored. The pool asks the same (#87). Distance has no field: it reads
 * the home everybody has, so it never waits (ADR-061 §7).
 */
export const pausedOf = (field: string, own: Record<string, unknown>): boolean =>
  field !== "distance" && own[field] === undefined;

/** The first accepted answer that is no option of the field, or null when every one is. */
function invalidAccept(dealBreaker: DealBreaker): string | null {
  const options = dealBreakerOptions(dealBreaker.field);
  return dealBreaker.accept.find((option) => !options.includes(option)) ?? null;
}

/** A filter on distance is up to a band, the nearer ones with it (ADR-061 §7): nothing skipped, nothing twice. */
function upToABand(accept: readonly string[]): boolean {
  const bands: readonly string[] = DISTANCE_FILTER_BANDS.slice(0, accept.length);
  return bands.length === accept.length && bands.every((band) => accept.includes(band));
}

/** A stored row of `preferences` on a deal-breaker's field. */
export type DealBreakerRow = { field: string; value: unknown; include_unknown: boolean };

/**
 * Stored rows as the deal-breakers they still are: a field that left the
 * whitelist reads as none; so does an option that left the registry (ADR-009
 * §1), and a row with no option left: the next save removes it, since it is
 * not in the set sent. The caller's own read and the round builder's of many
 * people at once (#87) read them alike. Nobody is unknown to a filter on
 * distance, so it lets them through whatever a row says: a short round then
 * offers it set aside alone (ADR-061 §7).
 */
export function dealBreakersFrom(rows: readonly DealBreakerRow[]): DealBreaker[] {
  return rows.flatMap((row) => {
    if (!WHITELIST.includes(row.field)) return [];
    const field = row.field as DealBreaker["field"];
    const options = dealBreakerOptions(field);
    const accept = (Accept.safeParse(row.value).data ?? []).filter((o) => options.includes(o));
    const includeUnknown = field === "distance" || row.include_unknown;
    return accept.length === 0 ? [] : [{ field, accept, includeUnknown }];
  });
}

/** The caller's own deal-breakers, with each one's pause read off the own answers. */
export async function readDealBreakers(
  db: Queryable,
  accountId: string,
  own: Record<string, unknown>,
): Promise<StoredDealBreaker[]> {
  const { rows } = await db.query<DealBreakerRow>(
    `SELECT field, value, include_unknown FROM preferences
     WHERE account_id = $1 AND mode = 'hard' AND field = ANY($2::text[])
     ORDER BY field`,
    [accountId, WHITELIST],
  );
  return dealBreakersFrom(rows).map((dealBreaker) => ({
    ...dealBreaker,
    paused: pausedOf(dealBreaker.field, own),
  }));
}

/** The same filter: one field, the same accepted answers in any order, the same switch. */
const sameFilter = (a: DealBreaker, b: DealBreaker): boolean =>
  a.field === b.field &&
  a.includeUnknown === b.includeUnknown &&
  JSON.stringify([...a.accept].sort()) === JSON.stringify([...b.accept].sort());

/**
 * The whole set, replaced: each on a distinct whitelisted field, accepting
 * options the field has, one relation of a number (#508), or the bands up to
 * one (ADR-061 §7). At most `max`, though a person already past a number the
 * panel lowered may still remove or change what they hold: only a new field
 * past `max` is refused (#551), or removing one of five under three, which
 * still sends four, would freeze them all. A filter set or changed on what the
 * person will not say about themselves is refused as `filter_unanswered`, with
 * the field, so the screen can ask for the answer instead; a paused one sent
 * back as it stands is kept, since the phone sends the whole set and a pause
 * deletes nothing (ADR-009 §1). Nothing of onboarding's two rows is touched.
 */
export async function saveDealBreakers(
  db: Queryable,
  accountId: string,
  update: DealBreakersUpdate,
  own: Record<string, unknown>,
  max: number,
  at: Date,
): Promise<boolean> {
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
    if (dealBreaker.field === "distance") {
      if (!upToABand(dealBreaker.accept)) {
        throw new AppError(400, "validation_failed", "The bands up to one", {
          field: dealBreaker.field,
        });
      }
    } else if (
      PROFILE_FIELDS[dealBreaker.field].kind === "number" &&
      dealBreaker.accept.length > 1
    ) {
      throw new AppError(400, "validation_failed", "One relation at most", {
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
    // Read under the lock, so the number and a paused filter are held to what is stored now.
    const { rows } = await tx.query<DealBreakerRow>(
      `SELECT field, value, include_unknown FROM preferences
       WHERE account_id = $1 AND mode = 'hard' AND field = ANY($2::text[])`,
      [accountId, WHITELIST],
    );
    const stored = dealBreakersFrom(rows);
    if (fields.length > max && fields.some((field) => !stored.some((d) => d.field === field))) {
      throw new AppError(400, "validation_failed", "More deal-breakers than allowed", { max });
    }
    for (const dealBreaker of update.dealBreakers) {
      if (!pausedOf(dealBreaker.field, own)) continue;
      if (stored.some((kept) => sameFilter(kept, dealBreaker))) continue;
      throw new AppError(409, "filter_unanswered", "Answer the field yourself first", {
        field: dealBreaker.field,
      });
    }
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
          dealBreaker.field === "distance" || dealBreaker.includeUnknown,
          at,
        ],
      );
    }
    return true;
  });
}
