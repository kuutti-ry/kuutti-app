import { AGE_MAX, AGE_MIN, GENDERS, PROFILE_FIELDS } from "@kuutti/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Intent,
  inEachOthersPool,
  intentsFit,
  type PoolPerson,
  passesFiltersOf,
} from "./pool.ts";

// features/pond/gate.feature (#94, #147, ADR-015): who is in whose pool.

type Gender = PoolPerson["gender"];

const person = (
  gender: Gender,
  age: number,
  seeks: string,
  min: number,
  max: number,
  intent: Intent = "open_to_either",
): PoolPerson => ({
  gender,
  age,
  seeks: seeks.split(",") as Gender[],
  ageWindow: { min, max },
  intent,
});

describe("Two people are in each other's pool only when each passes what the other asked for", () => {
  it.each([
    [
      "woman",
      30,
      "man",
      25,
      40,
      "open_to_either",
      "man",
      35,
      "woman",
      25,
      40,
      "open_to_either",
      "in",
    ],
    [
      "woman",
      30,
      "man",
      25,
      40,
      "open_to_either",
      "man",
      35,
      "man",
      25,
      40,
      "open_to_either",
      "not in",
    ],
    [
      "woman",
      30,
      "man",
      25,
      34,
      "open_to_either",
      "man",
      35,
      "woman",
      25,
      40,
      "open_to_either",
      "not in",
    ],
    [
      "woman",
      41,
      "man",
      25,
      45,
      "open_to_either",
      "man",
      35,
      "woman",
      25,
      40,
      "open_to_either",
      "not in",
    ],
    [
      "woman",
      30,
      "woman",
      25,
      40,
      "open_to_either",
      "woman",
      28,
      "woman",
      25,
      40,
      "open_to_either",
      "in",
    ],
    [
      "non_binary",
      30,
      "man,non_binary",
      25,
      40,
      "open_to_either",
      "man",
      35,
      "non_binary",
      25,
      40,
      "open_to_either",
      "in",
    ],
    [
      "non_binary",
      30,
      "man",
      25,
      40,
      "open_to_either",
      "man",
      35,
      "woman",
      25,
      40,
      "open_to_either",
      "not in",
    ],
    [
      "woman",
      25,
      "man",
      25,
      40,
      "open_to_either",
      "man",
      40,
      "woman",
      25,
      40,
      "open_to_either",
      "in",
    ],
    ["woman", 30, "man", 25, 40, "long_term", "man", 35, "woman", 25, 40, "long_term", "in"],
    ["woman", 30, "man", 25, 40, "long_term", "man", 35, "woman", 25, 40, "casual", "not in"],
    ["woman", 30, "man", 25, 40, "long_term", "man", 35, "woman", 25, 40, "open_to_either", "in"],
    ["woman", 30, "man", 25, 40, "open_to_either", "man", 35, "woman", 25, 40, "casual", "in"],
    ["woman", 30, "man", 25, 40, "casual", "man", 35, "woman", 25, 40, "casual", "in"],
    [
      "woman",
      30,
      "man",
      25,
      40,
      "dance_partner",
      "man",
      35,
      "woman",
      25,
      40,
      "dance_partner",
      "in",
    ],
    [
      "woman",
      30,
      "man",
      25,
      40,
      "dance_partner",
      "man",
      35,
      "woman",
      25,
      40,
      "long_term",
      "not in",
    ],
    ["woman", 30, "man", 25, 40, "dance_partner", "man", 35, "woman", 25, 40, "casual", "not in"],
    [
      "woman",
      30,
      "man",
      25,
      40,
      "dance_partner",
      "man",
      35,
      "woman",
      25,
      40,
      "open_to_either",
      "not in",
    ],
  ] as const)(
    "a %s of %i who seeks %s between %i and %i, here for %s, and a %s of %i who seeks %s between %i and %i, here for %s: %s",
    (aGender, aAge, aSeeks, aMin, aMax, aIntent, bGender, bAge, bSeeks, bMin, bMax, bIntent, expected) => {
      const a = person(aGender, aAge, aSeeks, aMin, aMax, aIntent);
      const b = person(bGender, bAge, bSeeks, bMin, bMax, bIntent);
      expect(inEachOthersPool(a, b)).toBe(expected === "in");
      expect(inEachOthersPool(b, a)).toBe(expected === "in");
    },
  );
});

describe("The sheet's examples of who is shown to whom, by gender and seek", () => {
  // The "3. Examples" table of the field sheet's gender model (#147, TD-14):
  // A appears in B's round exactly when A's gender is among B's seeks and the other way round.
  // Each example again with two dance partners, whom the same rule holds to (#175).
  it.each([
    ["man", "man", "man", "man", "open_to_either", "yes"],
    ["man", "man", "man", "man", "dance_partner", "yes"],
    ["woman", "woman,man", "man", "woman", "open_to_either", "yes"],
    ["woman", "woman,man", "man", "woman", "dance_partner", "yes"],
    ["woman", "non_binary", "non_binary", "woman", "open_to_either", "yes"],
    ["woman", "non_binary", "non_binary", "woman", "dance_partner", "yes"],
    ["woman", "non_binary", "non_binary", "man", "open_to_either", "no"],
    ["woman", "non_binary", "non_binary", "man", "dance_partner", "no"],
    ["non_binary", "woman", "woman", "man", "open_to_either", "no"],
    ["non_binary", "woman", "woman", "man", "dance_partner", "no"],
    ["man", "woman", "woman", "woman,man,non_binary", "open_to_either", "yes"],
    ["man", "woman", "woman", "woman,man,non_binary", "dance_partner", "yes"],
    ["non_binary", "woman,man,non_binary", "man", "woman", "open_to_either", "no"],
    ["non_binary", "woman,man,non_binary", "man", "woman", "dance_partner", "no"],
  ] as const)(
    "a %s seeking %s and a %s seeking %s, both here for %s: shown to each other, %s",
    (aGender, aSeeks, bGender, bSeeks, intent, shown) => {
      const a = person(aGender, 30, aSeeks, 18, 99, intent);
      const b = person(bGender, 30, bSeeks, 18, 99, intent);
      expect(inEachOthersPool(a, b)).toBe(shown === "yes");
      expect(inEachOthersPool(b, a)).toBe(shown === "yes");
    },
  );
});

const genderArb = fc.constantFrom(...GENDERS);
const intentArb = fc.constantFrom(...PROFILE_FIELDS.intent.options);
const personArb: fc.Arbitrary<PoolPerson> = fc
  .record({
    gender: genderArb,
    age: fc.integer({ min: AGE_MIN, max: AGE_MAX }),
    seeks: fc.uniqueArray(genderArb, { minLength: 1, maxLength: GENDERS.length }),
    a: fc.integer({ min: AGE_MIN, max: AGE_MAX }),
    b: fc.integer({ min: AGE_MIN, max: AGE_MAX }),
    intent: intentArb,
  })
  .map(({ gender, age, seeks, a, b, intent }) => ({
    gender,
    age,
    seeks,
    ageWindow: { min: Math.min(a, b), max: Math.max(a, b) },
    intent,
  }));

describe("the pool, for any two people", () => {
  it("is the same asked from either side", () => {
    fc.assert(
      fc.property(personArb, personArb, (a, b) => {
        expect(inEachOthersPool(a, b)).toBe(inEachOthersPool(b, a));
      }),
    );
  });

  it("never holds somebody a hard filter excludes, in either direction (rule 7)", () => {
    fc.assert(
      fc.property(personArb, personArb, (a, b) => {
        if (!inEachOthersPool(a, b)) return;
        for (const [viewer, candidate] of [
          [a, b],
          [b, a],
        ] as const) {
          expect(viewer.seeks).toContain(candidate.gender);
          expect(candidate.age).toBeGreaterThanOrEqual(viewer.ageWindow.min);
          expect(candidate.age).toBeLessThanOrEqual(viewer.ageWindow.max);
        }
        // Intent fits both ways: two answers that differ are "open to either" beside
        // long-term or casual (#147), never beside a dance partner (#175).
        expect(intentsFit(a.intent, b.intent)).toBe(true);
        if (a.intent !== b.intent) {
          expect([a.intent, b.intent]).toContain("open_to_either");
          expect([a.intent, b.intent]).not.toContain("dance_partner");
        }
      }),
    );
  });

  it("lets a dance partner meet a dance partner and nobody else, asked from either side (#175)", () => {
    fc.assert(
      fc.property(personArb, personArb, (a, b) => {
        const dancer = { ...a, intent: "dance_partner" as const };
        expect(inEachOthersPool(dancer, b)).toBe(inEachOthersPool(b, dancer));
        if (b.intent !== "dance_partner") expect(inEachOthersPool(dancer, b)).toBe(false);
        expect(intentsFit("dance_partner", b.intent)).toBe(b.intent === "dance_partner");
        expect(intentsFit(b.intent, "dance_partner")).toBe(b.intent === "dance_partner");
      }),
    );
  });

  it("holds everybody who passes both ways: nobody is left out for anything else", () => {
    fc.assert(
      fc.property(personArb, personArb, (a, b) => {
        expect(inEachOthersPool(a, b)).toBe(passesFiltersOf(a, b) && passesFiltersOf(b, a));
      }),
    );
  });
});
