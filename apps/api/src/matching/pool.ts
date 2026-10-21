import type { AgeWindow, DealBreaker, Gender, ProfileFields, Relaxation } from "@kuutti/schema";
import { pausedOf } from "./deal-breakers.ts";

/**
 * Who can be shown to whom (TD-10, TD-12, TD-14; #147, #87): every hard
 * filter, in both directions (rule 7). A is in B's pool exactly when B is in
 * A's: each one's gender is among those the other seeks, each one's age is
 * inside the other's window, the two want the same thing, or one of them is
 * open to either and the other is no dance partner (ADR-015 §10, §13),
 * neither has blocked the other (#84, ADR-030 §2), and each one's answers
 * pass the other's deal-breakers (#149, #87). The pond gate counts a
 * person's pool with this (#94) and the round builder draws its candidates
 * through it (#95), so that no caller can show somebody a filter excludes.
 * The soft preferences only order what passes (`soft.ts`); hiding from one's
 * own field is a setting the round builder reads (ADR-019 §5), not a filter.
 *
 * Pure, and it names no gender: the rule is the same for everybody.
 */
export type Intent = NonNullable<ProfileFields["intent"]>;

export type PoolPerson = {
  gender: Gender;
  /** Never empty: a person without an answer is not in anybody's pool. */
  seeks: readonly Gender[];
  ageWindow: AgeWindow;
  /** Whole years as the card says them (`ageInYears` of the profile slice), so a card never shows an age a window excludes. */
  age: number;
  /** What the person is here for; an onboarding step (#146), so never missing from a finished profile. */
  intent: Intent;
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

/**
 * Whether a deal-breaker lets an answer through (#149, the field sheet's
 * mutual rule): an accepted option, for a list such as the languages any one
 * of them, or no answer at all when the holder lets those through.
 */
export function accepts(dealBreaker: DealBreaker, answer: unknown): boolean {
  if (answer === undefined) return dealBreaker.includeUnknown;
  const given: readonly unknown[] = Array.isArray(answer) ? answer : [answer];
  return given.some((option) => (dealBreaker.accept as readonly unknown[]).includes(option));
}

/** One direction: whether `candidate` passes what `viewer` asked for. */
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
        accepts(dealBreaker, candidate.fields[dealBreaker.field]),
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
