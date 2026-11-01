import {
  type AgeWindow,
  type DealBreaker,
  type DistanceBand,
  type DistanceEdges,
  distanceBand,
  type Gender,
  type ProfileFields,
  type Relaxation,
} from "@kuutti/schema";
import { pausedOf } from "./deal-breakers.ts";

/**
 * Who can be shown to whom (TD-10, TD-12, TD-14; #147, #87): every hard
 * filter, in both directions (rule 7). A is in B's pool exactly when B is in
 * A's: each one's gender is among those the other seeks, each one's age is
 * inside the other's window, the two want the same thing, or one of them is
 * open to either and the other is no dance partner (ADR-015 §10, §13),
 * neither has blocked the other (#84, ADR-030 §2), and each one's answers
 * and the distance between the two pass the other's deal-breakers (#149, #87,
 * ADR-061 §7). The round builder draws its candidates through this (#95), so
 * that no caller can show somebody a filter excludes.
 * The soft preferences only order what passes (`soft.ts`); hiding from one's
 * own field is a setting the round builder reads (ADR-019 §5), not a filter.
 *
 * Pure, and it names no gender: the rule is the same for everybody.
 */
export type Intent = NonNullable<ProfileFields["intent"]>;

/**
 * Where a person lives, as the pool measures it (ADR-061 §5): their kept
 * place's centre in ETRS-TM35FIN metres, and the bands' edges of the same read,
 * so that the rules stay functions of what they are handed.
 */
export type PoolHome = { x: number; y: number; edges: DistanceEdges };

export type PoolPerson = {
  gender: Gender;
  /** Never empty: a person without an answer is not in anybody's pool. */
  seeks: readonly Gender[];
  ageWindow: AgeWindow;
  /** Whole years as the card says them (`ageInYears` of the profile slice), so a card never shows an age a window excludes. */
  age: number;
  /** What the person is here for; an onboarding step (#146), so never missing from a finished profile. */
  intent: Intent;
  /** Where the person lives; an onboarding step (ADR-061 §1), so never missing from a finished profile. */
  home: PoolHome;
  /** The person's identity: a block is between identities, so it holds for a later account (#84). */
  identityId: string;
  /** The identities this person blocked (#84). Read here and nowhere else: a block is a filter, never a signal. */
  blocks: ReadonlySet<string>;
  /** The person's own answers, as the registry reads them (a removed option is unanswered): what others' deal-breakers ask, and what pauses the person's own. */
  fields: ProfileFields;
  /** The person's deal-breakers as stored (#149); one on a field the person has not answered themselves is paused and filters nothing. */
  dealBreakers: readonly DealBreaker[];
};

/**
 * The intents fit when they are the same, or one side is open to either and
 * the other is no dance partner: "either" is long-term or casual, and a dance
 * partner meets a dance partner only (#175).
 */
export function intentsFit(a: Intent, b: Intent): boolean {
  if (a === b) return true;
  if (a === "dance_partner" || b === "dance_partner") return false;
  return a === "open_to_either" || b === "open_to_either";
}

/** The straight line between two kept places' centres (ADR-061 §5): only ever said as a band. */
export function kmBetween(a: PoolHome, b: PoolHome): number {
  return Math.hypot(a.x - b.x, a.y - b.y) / 1000;
}

/** The band two homes are in, the same asked from either side: the line is, and a read's edges are one. */
export function bandBetween(a: PoolHome, b: PoolHome): DistanceBand {
  return distanceBand(kmBetween(a, b), a.edges);
}

/** How the other person's number stands to the holder's own: what a deal-breaker on height accepts (#508). */
const RELATIONS: Readonly<Record<string, (theirs: number, own: number) => boolean>> = {
  taller: (theirs, own) => theirs > own,
  at_least_mine: (theirs, own) => theirs >= own,
  shorter: (theirs, own) => theirs < own,
};

/**
 * Whether a deal-breaker lets an answer through (#149, the field sheet's
 * mutual rule): an accepted option, for a list such as the languages any one
 * of them, a number that stands as accepted to the holder's `own` (#508), or
 * no answer at all when the holder lets those through.
 */
export function accepts(dealBreaker: DealBreaker, answer: unknown, own: unknown): boolean {
  if (answer === undefined) return dealBreaker.includeUnknown;
  if (typeof answer === "number" && typeof own === "number") {
    return dealBreaker.accept.some((relation) => RELATIONS[relation]?.(answer, own));
  }
  const given: readonly unknown[] = Array.isArray(answer) ? answer : [answer];
  return given.some((option) => (dealBreaker.accept as readonly unknown[]).includes(option));
}

/**
 * One direction: whether `candidate` passes what `viewer` asked for. A
 * deal-breaker on distance asks the pair's band, which everybody has, in place
 * of an answer of the candidate's (ADR-061 §7).
 */
export function passesFiltersOf(viewer: PoolPerson, candidate: PoolPerson): boolean {
  return (
    !viewer.blocks.has(candidate.identityId) &&
    viewer.seeks.includes(candidate.gender) &&
    candidate.age >= viewer.ageWindow.min &&
    candidate.age <= viewer.ageWindow.max &&
    intentsFit(viewer.intent, candidate.intent) &&
    viewer.dealBreakers.every(
      (dealBreaker) =>
        pausedOf(dealBreaker.field, viewer.fields) ||
        (dealBreaker.field === "distance"
          ? accepts(dealBreaker, bandBetween(viewer.home, candidate.home), undefined)
          : accepts(
              dealBreaker,
              candidate.fields[dealBreaker.field],
              viewer.fields[dealBreaker.field],
            )),
    )
  );
}

/**
 * The person with their own deal-breakers loosened for the day (#99, ADR-042
 * §3): `unanswered` lets through who did not answer the field, `aside` drops
 * the deal-breaker. Nothing else of the person changes, and nothing of anybody
 * else: asked both ways, whoever passes is still somebody whose own filters
 * let the person through. A like on a relaxed card waives so the fields
 * that card came in under, for its one person (§7).
 */
export function relaxedBy(person: PoolPerson, relaxations: readonly Relaxation[]): PoolPerson {
  if (relaxations.length === 0) return person;
  const how = new Map(relaxations.map((r) => [r.field as string, r.kind]));
  return {
    ...person,
    dealBreakers: person.dealBreakers.flatMap((dealBreaker) => {
      const kind = how.get(dealBreaker.field);
      if (kind === "aside") return [];
      return kind === "unanswered" ? [{ ...dealBreaker, includeUnknown: true }] : [dealBreaker];
    }),
  };
}

/** Both directions, which is the only way anybody is ever shown to anybody. */
export function inEachOthersPool(a: PoolPerson, b: PoolPerson): boolean {
  return passesFiltersOf(a, b) && passesFiltersOf(b, a);
}
