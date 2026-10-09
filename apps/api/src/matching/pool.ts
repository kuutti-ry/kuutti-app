import type { AgeWindow, Gender, ProfileFields } from "@kuutti/schema";

/**
 * Who can be shown to whom (TD-10, TD-12, TD-14; #147): the hard filters of
 * onboarding, in both directions (rule 7). A is in B's pool exactly when B is
 * in A's: each one's gender is among those the other seeks, each one's age
 * is inside the other's window, and the two want the same thing, or one of
 * them is open to either (ADR-015 §4). The pond gate counts a person's pool
 * with this (#94) and the round builder draws its candidates through it
 * (#95); blocks and deal-breakers join here with #87, so that no caller can
 * show somebody a filter excludes.
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
};

/** The intents fit when they are the same, or one side is open to either. */
export function intentsFit(a: Intent, b: Intent): boolean {
  return a === b || a === "open_to_either" || b === "open_to_either";
}

/** One direction: whether `candidate` passes what `viewer` asked for. */
export function passesFiltersOf(viewer: PoolPerson, candidate: PoolPerson): boolean {
  return (
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
