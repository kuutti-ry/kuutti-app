import { PROFILE_FIELD_KEYS, PROFILE_FIELDS, type ProfileFields } from "@kuutti/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readersOf, withoutComments } from "../test/sources.ts";
import { softMatches } from "./soft.ts";

// features/matching/filters.feature (#87): the soft preferences, which only
// order a round. Whether they leave anybody out of a pool is pool.test.ts's.

/** "education=kandi,drinking=rarely" as answers; "nothing" as none. */
const answers = (text: string): ProfileFields =>
  text === "nothing"
    ? {}
    : (Object.fromEntries(text.split(",").map((pair) => pair.split("="))) as ProfileFields);

describe("Soft preferences count only what is similar from both sides", () => {
  it.each([
    ["drinking=never", "drinking=never", 1],
    ["drinking=never", "drinking=rarely", 1],
    ["drinking=never", "drinking=socially", 0],
    ["drinking=socially", "drinking=often", 1],
    ["education=amk", "education=kandi", 1],
    ["education=toinen_aste", "education=kandi", 0],
    ["education=maisteri", "education=tohtori", 1],
    ["education=peruskoulu", "education=tohtori", 0],
    ["drugsAttitude=not_my_thing", "drugsAttitude=dont_mind", 1],
    ["drugsAttitude=not_my_thing", "drugsAttitude=fine_with_it", 0],
    ["drinking=never", "nothing", 0],
    ["drinking=never", "education=amk", 0],
    [
      "education=kandi,drinking=rarely,drugsAttitude=dont_mind",
      "education=maisteri,drinking=socially,drugsAttitude=fine_with_it",
      3,
    ],
    ["education=kandi,drinking=rarely", "education=peruskoulu,drinking=rarely", 1],
  ] as const)("%s and %s: similar on %i", (mine, theirs, count) => {
    expect(softMatches(answers(mine), answers(theirs))).toBe(count);
    expect(softMatches(answers(theirs), answers(mine))).toBe(count);
  });
});

const SOFT = PROFILE_FIELD_KEYS.filter((key) => PROFILE_FIELDS[key].preferenceAbout === "soft");
const optionsOf = (key: (typeof SOFT)[number]): readonly string[] => {
  const spec = PROFILE_FIELDS[key];
  return "options" in spec ? spec.options : [];
};
/** Any of the soft fields answered or left open, and any other answer beside them. */
const softArb = fc.record(
  {
    ...Object.fromEntries(SOFT.map((key) => [key, fc.constantFrom(...optionsOf(key))])),
    smoking: fc.constantFrom(...PROFILE_FIELDS.smoking.options),
    intent: fc.constantFrom(...PROFILE_FIELDS.intent.options),
  },
  { requiredKeys: [] },
) as fc.Arbitrary<ProfileFields>;

describe("the soft count, for any two people", () => {
  it("is the same from either side, and at most the soft fields both answered", () => {
    fc.assert(
      fc.property(softArb, softArb, (a, b) => {
        const both = SOFT.filter((key) => a[key] !== undefined && b[key] !== undefined).length;
        expect(softMatches(a, b)).toBe(softMatches(b, a));
        expect(softMatches(a, b)).toBeGreaterThanOrEqual(0);
        expect(softMatches(a, b)).toBeLessThanOrEqual(both);
      }),
    );
  });

  it("counts every soft field of the registry, and nothing else", () => {
    // The fields are the registry's (`preferenceAbout`), each a single choice whose order is its steps.
    expect(SOFT).toEqual(["education", "drinking", "drugsAttitude"]);
    for (const key of SOFT) expect(PROFILE_FIELDS[key].kind).toBe("single");
    fc.assert(
      fc.property(softArb, (a) => {
        // A person is similar to themselves on each soft field they answered, and on nothing else.
        expect(softMatches(a, a)).toBe(SOFT.filter((key) => a[key] !== undefined).length);
      }),
    );
  });

  it("is nothing for a person who answered none of them", () => {
    fc.assert(
      fc.property(softArb, (a) => {
        expect(softMatches({}, a)).toBe(0);
        expect(softMatches({ smoking: "never", intent: "casual" }, a)).toBe(0);
      }),
    );
  });
});

describe("the soft count's readers", () => {
  it("The soft count is read by the round's order alone", () => {
    // Never a card, an event, a log line or a route: the matching document's
    // invariant 6. The round builder (#95) joins this list when it orders a round.
    expect(readersOf((source) => /\bsoftMatches\b/.test(withoutComments(source)))).toEqual([
      "apps/api/src/matching/soft.ts",
    ]);
  });
});
