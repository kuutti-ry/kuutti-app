import { createHash } from "node:crypto";
import type { ProfileFields } from "@kuutti/schema";
import { inEachOthersPool, type PoolPerson } from "./pool.ts";
import { softMatches } from "./soft.ts";

/**
 * The places of a round that no rule forces (#95, ADR-035, the maintainer's
 * first cut of 20/10/2026): everybody in each other's pool, both ways
 * (rule 7), minus whom a hidden field keeps apart, the most soft matches
 * first (approach 1, counted without weights), up to the round's size. Equal
 * counts are ordered by a hash of the day, the owner and the candidate: a
 * different order for every person and every day, and the same one whenever
 * that day's round is built again. Pure; which people may be candidates at
 * all (visible, let in, not cooling down) is the builder's to say.
 */
export type RoundCandidate = { id: string; person: PoolPerson };

/**
 * ADR-019 §5: a person who hides from their own field never meets anybody
 * who named one of the same fields, and so, by the mutual rule, never sees
 * them either. Asked from either side, it answers the same.
 */
export function hiddenByField(a: ProfileFields, b: ProfileFields): boolean {
  if (a.hideFromField !== true && b.hideFromField !== true) return false;
  const theirs = new Set(b.field ?? []);
  return (a.field ?? []).some((field) => theirs.has(field));
}

/** Whether the two may meet in a round at all: two people, in each other's pool both ways, no hidden field between them. */
function mayMeet(owner: RoundCandidate, other: RoundCandidate): boolean {
  return (
    other.id !== owner.id &&
    inEachOthersPool(owner.person, other.person) &&
    !hiddenByField(owner.person.fields, other.person.fields)
  );
}

/**
 * The round's first places (#97, TD-11): the people whose like waits on the
 * owner, in the order given (the oldest like first), whoever of them may
 * still meet the owner, up to `cap`. No order of any approach moves them.
 */
export function likedYouPlaces(
  owner: RoundCandidate,
  waiting: readonly RoundCandidate[],
  cap: number,
): RoundCandidate[] {
  return waiting.filter((other) => mayMeet(owner, other)).slice(0, Math.max(0, cap));
}

/** The order among equal counts: the same for a day, an owner and a candidate, whenever it is asked. */
function tieOf(day: string, ownerId: string, candidateId: string): string {
  return createHash("sha256").update(`${day}\n${ownerId}\n${candidateId}`).digest("hex");
}

export function roundOrder(
  owner: RoundCandidate,
  others: readonly RoundCandidate[],
  round: { day: string; size: number },
): RoundCandidate[] {
  return (
    others
      .filter((other) => mayMeet(owner, other))
      .map((other) => ({
        other,
        count: softMatches(owner.person.fields, other.person.fields),
        tie: tieOf(round.day, owner.id, other.id),
      }))
      // Two candidates never share a hash: they are two ids.
      .sort((a, b) => b.count - a.count || (a.tie < b.tie ? -1 : 1))
      .slice(0, Math.max(0, round.size))
      .map(({ other }) => other)
  );
}
