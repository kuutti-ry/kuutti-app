import { createHash } from "node:crypto";
import { DISTANCE_BANDS, type ProfileFields } from "@kuutti/schema";
import { bandBetween, inEachOthersPool, type PoolPerson } from "./pool.ts";
import { softMatches } from "./soft.ts";

/**
 * The queue's order past the likes waiting (#95, #502, ADR-035, ADR-062 §2):
 * everybody in each other's pool, both ways (rule 7), minus whom a hidden field
 * keeps apart, new people the nearest band first (ADR-061 §6: with one pond
 * nothing else keeps people local), then the most soft matches (approach 1,
 * counted without weights). Equal counts are ordered by a hash of the day, the
 * owner and the candidate: a different order for every person and every day, and
 * the same one whenever it is read again that day. Pure; which people may be
 * candidates at all (visible, let in, not cooling down) is the builder's to say.
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

/** Whether the two may meet at all: two people, in each other's pool both ways, no hidden field between them. */
export function mayMeet(owner: RoundCandidate, other: RoundCandidate): boolean {
  return (
    other.id !== owner.id &&
    inEachOthersPool(owner.person, other.person) &&
    !hiddenByField(owner.person.fields, other.person.fields)
  );
}

/**
 * The queue's first places (#97, TD-11, ADR-062 §2): the people whose like
 * waits on the owner, in the order given (fish first, then the oldest like
 * first), whoever of them may still meet the owner. Nothing moves them, neither
 * fit nor distance.
 */
export function likedYouPlaces(
  owner: RoundCandidate,
  waiting: readonly RoundCandidate[],
): RoundCandidate[] {
  return waiting.filter((other) => mayMeet(owner, other));
}

/** The order among equal counts: the same for a day, an owner and a candidate, whenever it is asked. */
function tieOf(day: string, ownerId: string, candidateId: string): string {
  return createHash("sha256").update(`${day}\n${ownerId}\n${candidateId}`).digest("hex");
}

/** Why somebody seen before comes back, in the order they do (ADR-062 §2). */
const RETURNS = ["skipped", "passed", "liked", "ended"] as const;
export type Return = (typeof RETURNS)[number];

/** Somebody seen before who may come back (#99, ADR-042 §1): when last shown, and what they come back from. */
export type ComingBack = RoundCandidate & { lastShown: string; from: Return };

/**
 * The order in which people come back once nobody new is left (#99, ADR-042 §1,
 * TD-12, ADR-062 §2): skipped cards, then passed people, then people liked with
 * no answer, then former conversations, each group the one shown longest ago
 * first, equal days in the hash order; whoever of them may still meet the owner,
 * up to the size. No band moves them. Pure; who is past their clock is the
 * builder's to say.
 */
export function comingBackOrder(
  owner: RoundCandidate,
  others: readonly ComingBack[],
  round: { day: string; size: number },
): ComingBack[] {
  return others
    .filter((other) => mayMeet(owner, other))
    .map((other) => ({ other, tie: tieOf(round.day, owner.id, other.id) }))
    .sort(
      (a, b) =>
        RETURNS.indexOf(a.other.from) - RETURNS.indexOf(b.other.from) ||
        (a.other.lastShown < b.other.lastShown
          ? -1
          : a.other.lastShown > b.other.lastShown
            ? 1
            : 0) ||
        (a.tie < b.tie ? -1 : 1),
    )
    .slice(0, Math.max(0, round.size))
    .map(({ other }) => other);
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
        band: DISTANCE_BANDS.indexOf(bandBetween(owner.person.home, other.person.home)),
        count: softMatches(owner.person.fields, other.person.fields),
        tie: tieOf(round.day, owner.id, other.id),
      }))
      // Two candidates never share a hash: they are two ids.
      .sort((a, b) => a.band - b.band || b.count - a.count || (a.tie < b.tie ? -1 : 1))
      .slice(0, Math.max(0, round.size))
      .map(({ other }) => other)
  );
}
