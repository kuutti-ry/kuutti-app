import type { Queryable } from "@kuutti/db";
import type { RewardKind } from "@kuutti/schema";
import * as repo from "./repo.ts";

// The reward ledger as the matching slice's decide uses it (#107, ADR-044 §8,
// TD-15): a unit is spent by itself on the like or fish past the day's or the
// window's budget, and given back when that decision changes the same day.
// Every call runs in decide's transaction, under the round row's lock it
// holds, which serialises the person's own decisions; the SQL is this
// slice's, so matching reaches the reward table through these alone.

/**
 * Spends the person's oldest unit of the kind not used yet on the entry;
 * false when none is left, and the decision is refused as it was before.
 */
export async function spendEarned(
  tx: Queryable,
  input: { accountId: string; kind: RewardKind; entryId: string; at: Date },
): Promise<boolean> {
  return repo.spendOldest(tx, input);
}

/** Gives back the person's units of these kinds that paid for the entry; how many. */
export async function releaseEarned(
  tx: Queryable,
  input: { accountId: string; entryId: string; kinds: readonly RewardKind[] },
): Promise<number> {
  return repo.releaseOn(tx, input);
}

/**
 * The entries the person's units of a kind paid for, which the day's count of
 * likes or the window's of fish leaves out: without that, a banked unit used
 * today would fill the budget it was used past.
 */
export async function entriesPaidBy(
  tx: Queryable,
  accountId: string,
  kind: RewardKind,
): Promise<string[]> {
  return repo.paidEntries(tx, accountId, kind);
}
