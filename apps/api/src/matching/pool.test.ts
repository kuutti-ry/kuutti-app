import {
  AGE_MAX,
  AGE_MIN,
  DEAL_BREAKER_FIELDS,
  type DealBreaker,
  dealBreakerOptions,
  GENDERS,
  PROFILE_FIELD_KEYS,
  PROFILE_FIELDS,
  type ProfileFieldKey,
  type ProfileFields,
} from "@kuutti/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  accepts,
  type Intent,
  inEachOthersPool,
  intentsFit,
  type PoolPerson,
  passesFiltersOf,
  relaxedBy,
} from "./pool.ts";

// features/matching/filters.feature (#94, #147, ADR-015): who is in whose pool;
// features/safety/blocks.feature (#84, ADR-030): a block, set by either;
// features/matching/filters.feature (#87): the deal-breakers, both ways, and
// the soft answers, which no pool reads.

type Gender = PoolPerson["gender"];

let identities = 0;
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
  identityId: `identity-${++identities}`,
  blocks: new Set(),
  fields: { intent },
  dealBreakers: [],
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

const SOFT_FIELDS = PROFILE_FIELD_KEYS.filter(
  (key) => PROFILE_FIELDS[key].preferenceAbout === "soft",
);

const { min: HEIGHT_MIN, max: HEIGHT_MAX, relations: HEIGHT_RELATIONS } = PROFILE_FIELDS.height;
const heightArb = fc.integer({ min: HEIGHT_MIN, max: HEIGHT_MAX });

/** A few of a list's options, at least one: what a deal-breaker accepts, or the list's answer. */
const someOf = (key: ProfileFieldKey) => {
  const options = dealBreakerOptions(key);
  return fc.subarray([...options], { minLength: 1, maxLength: Math.min(3, options.length) });
};

/** An answer as the registry takes it: one option, for a list one or more of them, a number in its range. */
const answerArb = (key: ProfileFieldKey): fc.Arbitrary<unknown> => {
  const spec = PROFILE_FIELDS[key];
  if (spec.kind === "number") return fc.integer({ min: spec.min, max: spec.max });
  return spec.kind === "multi" ? someOf(key) : fc.constantFrom(...dealBreakerOptions(key));
};
/** Any of the given fields answered or left open: an open one is a missing key, as the registry reads it. */
const answersArb = (keys: readonly ProfileFieldKey[]) =>
  fc.record(Object.fromEntries(keys.map((key) => [key, answerArb(key)])), { requiredKeys: [] });
const dealBreakerArb: fc.Arbitrary<DealBreaker> = fc
  .constantFrom(...DEAL_BREAKER_FIELDS)
  .chain((field) =>
    fc.record({
      field: fc.constant(field),
      // A number's deal-breaker is one relation (#508), a list's as many options as one accepts.
      accept:
        field === "height" ? fc.constantFrom(...HEIGHT_RELATIONS).map((r) => [r]) : someOf(field),
      includeUnknown: fc.boolean(),
    }),
  );

const genderArb = fc.constantFrom(...GENDERS);
const intentArb = fc.constantFrom(...PROFILE_FIELDS.intent.options);
// A few identities, so that two people drawn at random often have blocked each other, or one the other.
const identityArb = fc.constantFrom("identity-a", "identity-b", "identity-c", "identity-d");
const personArb: fc.Arbitrary<PoolPerson> = fc
  .record({
    gender: genderArb,
    age: fc.integer({ min: AGE_MIN, max: AGE_MAX }),
    seeks: fc.uniqueArray(genderArb, { minLength: 1, maxLength: GENDERS.length }),
    a: fc.integer({ min: AGE_MIN, max: AGE_MAX }),
    b: fc.integer({ min: AGE_MIN, max: AGE_MAX }),
    intent: intentArb,
    identityId: identityArb,
    blocks: fc.uniqueArray(identityArb, { maxLength: 3 }),
    answers: answersArb([...DEAL_BREAKER_FIELDS, ...SOFT_FIELDS]),
    // Up to two, each on a field of its own (#149), which leaves pairs in each other's pool to
    // ask the rules of; paused when the field is open. The number is the config's (#508).
    dealBreakers: fc.uniqueArray(dealBreakerArb, { maxLength: 2, selector: (d) => d.field }),
  })
  .map(({ gender, age, seeks, a, b, intent, identityId, blocks, answers, dealBreakers }) => ({
    gender,
    age,
    seeks,
    ageWindow: { min: Math.min(a, b), max: Math.max(a, b) },
    intent,
    identityId,
    blocks: new Set(blocks),
    fields: { ...answers, intent } as ProfileFields,
    dealBreakers,
  }));

/**
 * Two people every filter but the deal-breakers lets through, both ways:
 * each one's gender among the other's seeks, any age, the same intent, no
 * block. Two people drawn apart are rarely in each other's pool, and a rule
 * about who stays in it says little about people who are out anyway.
 */
const pairArb: fc.Arbitrary<readonly [PoolPerson, PoolPerson]> = fc
  .tuple(personArb, personArb)
  .map(([a, b]) => {
    const anyAge = { min: AGE_MIN, max: AGE_MAX };
    const gender = a.seeks[0] ?? a.gender;
    const seeks = b.seeks.includes(a.gender) ? b.seeks : [...b.seeks, a.gender];
    return [
      { ...a, ageWindow: anyAge, blocks: new Set<string>(), identityId: "identity-a" },
      {
        ...b,
        gender,
        seeks,
        ageWindow: anyAge,
        intent: a.intent,
        fields: { ...b.fields, intent: a.intent },
        blocks: new Set<string>(),
        identityId: "identity-b",
      },
    ] as const;
  });

/** The person with their soft answers replaced, every other answer kept. */
const withSoft = (person: PoolPerson, soft: Record<string, unknown>): PoolPerson => {
  const rest = Object.fromEntries(
    Object.entries(person.fields).filter(([key]) => !SOFT_FIELDS.includes(key as ProfileFieldKey)),
  );
  return { ...person, fields: { ...rest, ...soft } as ProfileFields };
};

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
        // Nobody has blocked the other (#84).
        expect(a.blocks.has(b.identityId)).toBe(false);
        expect(b.blocks.has(a.identityId)).toBe(false);
        // Every deal-breaker of either that is not paused accepts the other's answer (#87).
        for (const [holder, other] of [
          [a, b],
          [b, a],
        ] as const) {
          for (const dealBreaker of holder.dealBreakers) {
            const own = holder.fields[dealBreaker.field];
            if (own === undefined) continue;
            expect(accepts(dealBreaker, other.fields[dealBreaker.field], own)).toBe(true);
          }
        }
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

  it("leaves out two people a block stands between, whoever set it, asked from either side (#84)", () => {
    fc.assert(
      fc.property(personArb, personArb, (a, b) => {
        if (a.blocks.has(b.identityId) || b.blocks.has(a.identityId)) {
          expect(inEachOthersPool(a, b)).toBe(false);
          expect(inEachOthersPool(b, a)).toBe(false);
        }
      }),
    );
  });

  it("leaves out two people a deal-breaker of either excludes, asked from either side (#87)", () => {
    fc.assert(
      fc.property(personArb, personArb, (a, b) => {
        const excludes = (holder: PoolPerson, other: PoolPerson) =>
          holder.dealBreakers.some(
            (d) =>
              holder.fields[d.field] !== undefined &&
              !accepts(d, other.fields[d.field], holder.fields[d.field]),
          );
        if (excludes(a, b) || excludes(b, a)) {
          expect(inEachOthersPool(a, b)).toBe(false);
          expect(inEachOthersPool(b, a)).toBe(false);
        }
      }),
    );
  });

  it("is the same with a paused deal-breaker as without it (#87)", () => {
    fc.assert(
      fc.property(fc.oneof(pairArb, fc.tuple(personArb, personArb)), ([a, b]) => {
        const live = a.dealBreakers.filter((d) => a.fields[d.field] !== undefined);
        expect(inEachOthersPool({ ...a, dealBreakers: live }, b)).toBe(inEachOthersPool(a, b));
        expect(inEachOthersPool(b, { ...a, dealBreakers: live })).toBe(inEachOthersPool(b, a));
      }),
    );
  });

  it("Soft preferences never take anybody out of a pool, nor bring anybody into one", () => {
    fc.assert(
      fc.property(
        fc.oneof(pairArb, fc.tuple(personArb, personArb)),
        answersArb(SOFT_FIELDS),
        answersArb(SOFT_FIELDS),
        ([a, b], softA, softB) => {
          const changed = inEachOthersPool(withSoft(a, softA), withSoft(b, softB));
          expect(changed).toBe(inEachOthersPool(a, b));
          expect(inEachOthersPool(withSoft(b, softB), withSoft(a, softA))).toBe(changed);
        },
      ),
    );
    // Two in each other's pool stay in it, as far apart as the soft answers go;
    // two out of it stay out, the same in every soft answer.
    const far = (p: PoolPerson, answers: Record<string, string>) => withSoft(p, answers);
    const [a, b] = [person("woman", 30, "woman", 25, 40), person("woman", 30, "woman", 25, 40)];
    const lowest = { education: "peruskoulu", drinking: "never", drugsAttitude: "not_my_thing" };
    const highest = { education: "tohtori", drinking: "often", drugsAttitude: "fine_with_it" };
    expect(inEachOthersPool(far(a, lowest), far(b, highest))).toBe(true);
    expect(inEachOthersPool(far(b, highest), far(a, lowest))).toBe(true);
    const out = person("man", 30, "woman", 25, 40);
    expect(inEachOthersPool(far(a, lowest), far(out, lowest))).toBe(false);
    expect(inEachOthersPool(far(out, lowest), far(a, lowest))).toBe(false);
  });

  it("holds everybody who passes both ways: nobody is left out for anything else", () => {
    fc.assert(
      fc.property(personArb, personArb, (a, b) => {
        expect(inEachOthersPool(a, b)).toBe(passesFiltersOf(a, b) && passesFiltersOf(b, a));
      }),
    );
  });
});

describe("blocks", () => {
  it("A block takes two people out of each other's pool, whoever set it", () => {
    const fits = () =>
      [person("woman", 30, "man", 25, 40), person("man", 35, "woman", 25, 40)] as const;
    const [a, b] = fits();
    expect(inEachOthersPool(a, b)).toBe(true);
    // A blocks B: out of each other's pool, asked from either side.
    const [c, d] = fits();
    const blocker = { ...c, blocks: new Set([d.identityId]) };
    expect(inEachOthersPool(blocker, d)).toBe(false);
    expect(inEachOthersPool(d, blocker)).toBe(false);
    // The other way round, and both, read the same.
    const [e, f] = fits();
    const blocked = { ...f, blocks: new Set([e.identityId]) };
    expect(inEachOthersPool(e, blocked)).toBe(false);
    expect(inEachOthersPool(blocked, e)).toBe(false);
    expect(inEachOthersPool({ ...e, blocks: new Set([f.identityId]) }, blocked)).toBe(false);
    // A block of somebody else leaves the two as they were.
    const [g, h] = fits();
    expect(inEachOthersPool({ ...g, blocks: new Set(["identity-elsewhere"]) }, h)).toBe(true);
  });
});

// features/matching/filters.feature (#87, #149): the deal-breakers in the pool.
describe("deal-breakers", () => {
  /** Two people in each other's pool by everything else: women of thirty who seek women. */
  const pair = () => [person("woman", 30, "woman", 25, 40), person("woman", 30, "woman", 25, 40)];
  /** The holder's own answer on each field, which keeps the deal-breaker from pausing. */
  const OWN: Partial<Record<DealBreaker["field"], unknown>> = {
    smoking: "never",
    languages: ["fi"],
    hasKids: "no",
    monogamy: "monogamous",
    height: 170,
  };
  const answered = (field: string, answer: string) =>
    answer === "nothing" ? {} : { [field]: field === "languages" ? answer.split(",") : answer };

  describe("A deal-breaker lets through only the answers its holder accepts, asked from either side", () => {
    it.each([
      ["smoking", "never", "without", "never", "in"],
      ["smoking", "never", "without", "regularly", "not in"],
      ["smoking", "never,quitting", "without", "quitting", "in"],
      ["smoking", "never", "without", "nothing", "not in"],
      ["smoking", "never", "with", "nothing", "in"],
      ["smoking", "never", "with", "vaping", "not in"],
      ["languages", "fi", "without", "sv,fi", "in"],
      ["languages", "fi,sv", "without", "en", "not in"],
      ["languages", "fi", "with", "nothing", "in"],
      ["hasKids", "no", "without", "yes_not_with_me", "not in"],
      ["monogamy", "monogamous", "without", "monogamous", "in"],
    ] as const)(
      "a deal-breaker on %s accepting %s, %s people who did not answer, and the other answered %s: %s",
      (field, accept, unknown, answer, expected) => {
        const [first, second] = pair();
        if (!first || !second) throw new Error("no pair");
        const holder: PoolPerson = {
          ...first,
          fields: { ...first.fields, [field]: OWN[field] },
          dealBreakers: [{ field, accept: accept.split(","), includeUnknown: unknown === "with" }],
        };
        const other: PoolPerson = {
          ...second,
          fields: { ...second.fields, ...answered(field, answer) },
        };
        // The holder first and second: the same answer from either side.
        expect(inEachOthersPool(holder, other)).toBe(expected === "in");
        expect(inEachOthersPool(other, holder)).toBe(expected === "in");
      },
    );
  });

  describe("A height deal-breaker compares the other person's height with the holder's own, asked from either side", () => {
    it.each([
      ["taller", "without", 171, "in"],
      ["taller", "without", 170, "not in"],
      ["taller", "without", 169, "not in"],
      ["at_least_mine", "without", 171, "in"],
      ["at_least_mine", "without", 170, "in"],
      ["at_least_mine", "without", 169, "not in"],
      ["shorter", "without", 169, "in"],
      ["shorter", "without", 170, "not in"],
      ["shorter", "without", 171, "not in"],
      ["taller", "without", "nothing", "not in"],
      ["taller", "with", "nothing", "in"],
      ["shorter", "with", 171, "not in"],
    ] as const)(
      "a holder of 170 cm accepting %s, %s people who did not answer, and the other's height %s: %s",
      (relation, unknown, theirs, expected) => {
        const [first, second] = pair();
        if (!first || !second) throw new Error("no pair");
        const holder: PoolPerson = {
          ...first,
          fields: { ...first.fields, height: 170 },
          dealBreakers: [
            { field: "height", accept: [relation], includeUnknown: unknown === "with" },
          ],
        };
        const other: PoolPerson = {
          ...second,
          fields: theirs === "nothing" ? second.fields : { ...second.fields, height: theirs },
        };
        // The holder first and second: the same answer from either side.
        expect(inEachOthersPool(holder, other)).toBe(expected === "in");
        expect(inEachOthersPool(other, holder)).toBe(expected === "in");
      },
    );
  });

  const asking = (base: PoolPerson, height: number, relation: string): PoolPerson => ({
    ...base,
    fields: { ...base.fields, height },
    dealBreakers: [{ field: "height", accept: [relation], includeUnknown: false }],
  });

  it("Two height deal-breakers are each asked from their holder's own height", () => {
    const [first, second] = pair();
    if (!first || !second) throw new Error("no pair");
    const shorter = asking(first, 165, "taller");
    const taller = asking(second, 180, "shorter");
    expect(inEachOthersPool(shorter, taller)).toBe(true);
    expect(inEachOthersPool(taller, shorter)).toBe(true);
    // Whatever the heights, one of two who both ask for somebody taller is refused.
    fc.assert(
      fc.property(heightArb, heightArb, (a, b) => {
        expect(inEachOthersPool(asking(first, a, "taller"), asking(second, b, "taller"))).toBe(
          false,
        );
      }),
    );
  });

  it("A height deal-breaker waits for its holder's own height", () => {
    const [first, second] = pair();
    if (!first || !second) throw new Error("no pair");
    const holder = asking(first, 170, "taller");
    const other: PoolPerson = { ...second, fields: { ...second.fields, height: 165 } };
    expect(inEachOthersPool(holder, other)).toBe(false);
    // The holder takes their own height back: there is nothing to compare with, and the filter waits.
    const paused: PoolPerson = { ...holder, fields: { intent: holder.intent } };
    expect(inEachOthersPool(paused, other)).toBe(true);
    expect(inEachOthersPool(other, paused)).toBe(true);
    // Answering again takes it up again.
    const again: PoolPerson = { ...paused, fields: { ...paused.fields, height: 170 } };
    expect(inEachOthersPool(again, other)).toBe(false);
    expect(inEachOthersPool(other, again)).toBe(false);
  });

  it("reads the three relations of any two heights as one comparison (#508)", () => {
    const relation = (accept: string) => ({
      field: "height" as const,
      accept: [accept],
      includeUnknown: false,
    });
    const taller = relation("taller");
    const mine = relation("at_least_mine");
    const shorter = relation("shorter");
    fc.assert(
      fc.property(heightArb, heightArb, (theirs, own) => {
        // Taller seen from one side is shorter seen from the other.
        expect(accepts(taller, theirs, own)).toBe(accepts(shorter, own, theirs));
        // My height or taller is everything shorter than me is not.
        expect(accepts(mine, theirs, own)).toBe(!accepts(shorter, theirs, own));
        // And it is taller, or the very same number.
        expect(accepts(mine, theirs, own)).toBe(accepts(taller, theirs, own) || theirs === own);
      }),
    );
  });

  it("refuses a height against a relation that left the registry, and a holder with no number (#508)", () => {
    const retired = { field: "height" as const, accept: ["much_taller"], includeUnknown: true };
    expect(accepts(retired, 180, 170)).toBe(false);
    // A pause keeps this from the pool (`passesFiltersOf`); asked anyway, it refuses.
    const taller = { field: "height" as const, accept: ["taller"], includeUnknown: true };
    expect(accepts(taller, 180, undefined)).toBe(false);
  });

  it("The deal-breakers of both people are asked, each against the other's answers", () => {
    const [first, second] = pair();
    if (!first || !second) throw new Error("no pair");
    const a: PoolPerson = {
      ...first,
      fields: { ...first.fields, smoking: "never", hasKids: "no" },
      dealBreakers: [{ field: "smoking", accept: ["never"], includeUnknown: false }],
    };
    const b: PoolPerson = {
      ...second,
      fields: { ...second.fields, smoking: "never", hasKids: "no" },
      dealBreakers: [{ field: "hasKids", accept: ["no"], includeUnknown: false }],
    };
    expect(inEachOthersPool(a, b)).toBe(true);
    // B now smokes, which A's deal-breaker does not accept.
    const bSmokes = { ...b, fields: { ...b.fields, smoking: "regularly" as const } };
    expect(inEachOthersPool(a, bSmokes)).toBe(false);
    expect(inEachOthersPool(bSmokes, a)).toBe(false);
    // A now has children, which B's deal-breaker does not accept.
    const aHasKids = { ...a, fields: { ...a.fields, hasKids: "yes_with_me" as const } };
    expect(inEachOthersPool(aHasKids, b)).toBe(false);
    expect(inEachOthersPool(b, aHasKids)).toBe(false);
  });

  it("A paused deal-breaker filters nothing", () => {
    const [first, second] = pair();
    if (!first || !second) throw new Error("no pair");
    const smoker: PoolPerson = { ...second, fields: { ...second.fields, smoking: "regularly" } };
    const dealBreakers = [{ field: "smoking" as const, accept: ["never"], includeUnknown: false }];
    const holder: PoolPerson = {
      ...first,
      fields: { ...first.fields, smoking: "never" },
      dealBreakers,
    };
    expect(inEachOthersPool(holder, smoker)).toBe(false);
    // The holder takes their own smoking answer back: the filter waits.
    const paused: PoolPerson = { ...holder, fields: { intent: holder.intent } };
    expect(inEachOthersPool(paused, smoker)).toBe(true);
    expect(inEachOthersPool(smoker, paused)).toBe(true);
    // Answering again, whatever the answer, takes it up again.
    const again: PoolPerson = { ...paused, fields: { ...paused.fields, smoking: "sometimes" } };
    expect(inEachOthersPool(again, smoker)).toBe(false);
    expect(inEachOthersPool(smoker, again)).toBe(false);
  });
});

describe("a person's deal-breakers relaxed for the day (#99, ADR-042 §3)", () => {
  const relaxationArb = fc.record({
    field: fc.constantFrom(...DEAL_BREAKER_FIELDS),
    kind: fc.constantFrom("unanswered" as const, "aside" as const),
  });

  it("never lets in somebody whose own filters exclude the person, and never leaves out anybody", () => {
    fc.assert(
      fc.property(pairArb, fc.array(relaxationArb, { maxLength: 3 }), ([a, b], relaxations) => {
        const wider = relaxedBy(a, relaxations);
        // The other side's filters still hold: whoever passes is somebody who lets the person through.
        if (inEachOthersPool(wider, b)) expect(passesFiltersOf(b, wider)).toBe(true);
        expect(passesFiltersOf(b, wider)).toBe(passesFiltersOf(b, a));
        // Loosening only ever widens.
        if (inEachOthersPool(a, b)) expect(inEachOthersPool(wider, b)).toBe(true);
      }),
    );
  });

  it("changes nothing of the person but their deal-breakers", () => {
    fc.assert(
      fc.property(personArb, fc.array(relaxationArb, { maxLength: 3 }), (a, relaxations) => {
        const { dealBreakers: _relaxed, ...rest } = relaxedBy(a, relaxations);
        const { dealBreakers: _stored, ...before } = a;
        expect(rest).toEqual(before);
      }),
    );
  });

  it("lets through those who did not answer, or sets the deal-breaker aside, and leaves the others as they are", () => {
    const smoking = { field: "smoking" as const, accept: ["never"], includeUnknown: false };
    const kids = { field: "hasKids" as const, accept: ["no"], includeUnknown: false };
    const holder: PoolPerson = {
      ...person("woman", 30, "woman", 25, 40),
      dealBreakers: [smoking, kids],
    };
    expect(relaxedBy(holder, [{ field: "smoking", kind: "unanswered" }]).dealBreakers).toEqual([
      { ...smoking, includeUnknown: true },
      kids,
    ]);
    expect(relaxedBy(holder, [{ field: "smoking", kind: "aside" }]).dealBreakers).toEqual([kids]);
    expect(relaxedBy(holder, [{ field: "languages", kind: "aside" }]).dealBreakers).toEqual([
      smoking,
      kids,
    ]);
    expect(relaxedBy(holder, [])).toBe(holder);
  });
});
