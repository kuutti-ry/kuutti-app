import type { Queryable } from "@kuutti/db";
import * as repo from "./repo.ts";

// The reward ledger as the matching slice's decide uses it (#107, ADR-044 §8,
// TD-15): a unit is spent by itself on the fish past the window's budget, and
// given back when that decision changes the same day. Every spend and
// give-back runs in decide's transaction, under the round row's lock it holds,
// which serialises the person's own decisions; whether a unit waits is only
// read. The SQL is this slice's, so matching reaches the reward table through
// these alone.

/**
 * Spends the person's oldest unit not used yet on the entry; false when none
 * is left, and the decision is refused as it was before.
 */
export async function spendEarned(
  tx: Queryable,
  input: { accountId: string; entryId: string; at: Date },
): Promise<boolean> {
  return repo.spendOldest(tx, input);
}

/** Gives back the person's units that paid for the entry; how many. */
export async function releaseEarned(
  tx: Queryable,
  input: { accountId: string; entryId: string },
): Promise<number> {
  return repo.releaseOn(tx, input);
}

/**
 * The entries the person's units paid for, which the window's count of fish
 * leaves out: without that, a banked unit used today would fill the budget it
 * was used past.
 */
export async function entriesPaidBy(tx: Queryable, accountId: string): Promise<string[]> {
  return repo.paidEntries(tx, accountId);
}

/**
 * Whether an earned fish waits on the person, which the next fish past the
 * window's budget would spend: the round offers a fish while one does (#475).
 */
export async function earnedFishWaiting(db: Queryable, accountId: string): Promise<boolean> {
  return (await repo.unspentOf(db, accountId)).fish > 0;
}
