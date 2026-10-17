import type { AgeWindow, Gender, ProfileFields } from "@kuutti/schema";

/**
 * Who can be shown to whom (TD-10, TD-12, TD-14; #147): the hard filters of
 * onboarding, in both directions (rule 7). A is in B's pool exactly when B is
 * in A's: each one's gender is among those the other seeks, each one's age
 * is inside the other's window, and the two want the same thing, or one of
 * them is open to either and the other is no dance partner (ADR-015 §10,
 * §13), and neither has blocked the other (#84, ADR-030 §2). The pond gate
 * counts a person's pool with this (#94) and the round builder draws its
 * candidates through it (#95); deal-breakers join here with #87, so that no
 * caller can show somebody a filter excludes.
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

/** One direction: whether `candidate` passes what `viewer` asked for. */
export function passesFiltersOf(viewer: PoolPerson, candidate: PoolPerson): boolean {
  return (
    !viewer.blocks.has(candidate.identityId) &&
    viewer.seeks.includes(candidate.gender) &&
    candidate.age >= viewer.ageWindow.min &&
    candidate.age <= viewer.ageWindow.max &&
    intentsFit(viewer.intent, candidate.intent)
  );
}

/** Both directions, which is the only way anybody is ever shown to anybody. */
export function inEachOthersPool(a: PoolPerson, b: PoolPerson): boolean {
  return passesFiltersOf(a, b) && passesFiltersOf(b, a);
}
