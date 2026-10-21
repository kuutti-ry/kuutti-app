import {
  AGE_MAX,
  AGE_MIN,
  GENDERS,
  PROFILE_FIELD_KEYS,
  PROFILE_FIELDS,
  type ProfileFields,
} from "@kuutti/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { inEachOthersPool, type PoolPerson } from "./pool.ts";
import {
  type ComingBack,
  comingBackOrder,
  hiddenByField,
  likedYouPlaces,
  type RoundCandidate,
  roundOrder,
} from "./round-order.ts";
import { softMatches } from "./soft.ts";

// The order of a round's places no rule forces (#95, ADR-035;
// features/matching/rounds.feature): the pool both ways, a hidden field, the
// soft matches first, ties in an order of the day's and the owner's, and the
// round's size. The builder over a database is jobs/round-builder.test.ts.

const DAY = "2026-10-20";
const FIELDS = PROFILE_FIELDS.field.options;
const SOFT = PROFILE_FIELD_KEYS.filter(
  (key) => PROFILE_FIELDS[key].preferenceAbout === "soft" && PROFILE_FIELDS[key].kind === "single",
);

/** A woman of 30 who seeks men of 25 to 40, open to either, with these answers. */
const woman = (id: string, fields: ProfileFields = {}): RoundCandidate => ({
  id,
  person: {
    gender: "woman",
    seeks: ["man"],
    ageWindow: { min: 25, max: 40 },
    age: 30,
    intent: "open_to_either",
    identityId: `identity-${id}`,
    blocks: new Set(),
    fields: { intent: "open_to_either", ...fields },
    dealBreakers: [],
  },
});

/** A man of 30 who seeks women of 25 to 40: in the pool of every `woman`. */
const man = (id: string, fields: ProfileFields = {}): RoundCandidate => {
  const her = woman(id, fields);
  return { id, person: { ...her.person, gender: "man", seeks: ["woman"] } };
};

const ids = (round: readonly RoundCandidate[]) => round.map((candidate) => candidate.id);

describe("A round holds at most round_size cards, the most soft matches first", () => {
  const owner = woman("owner", { education: "amk", drinking: "rarely", drugsAttitude: "never" });
  // Similar on two soft fields, on one, on none (the step next door is similar, ADR-019 §1).
  const two = man("two", { education: "kandi", drinking: "never", drugsAttitude: "often" });
  const one = man("one", { education: "amk", drinking: "often" });
  const none = man("none", {});

  it("keeps the most matches, in order, up to the size", () => {
    expect(softMatches(owner.person.fields, two.person.fields)).toBe(2);
    expect(softMatches(owner.person.fields, one.person.fields)).toBe(1);
    expect(ids(roundOrder(owner, [none, one, two], { day: DAY, size: 2 }))).toEqual(["two", "one"]);
    expect(ids(roundOrder(owner, [none, one, two], { day: DAY, size: 10 }))).toEqual([
      "two",
      "one",
      "none",
    ]);
  });

  it("is empty for a size of nothing, or below it", () => {
    expect(roundOrder(owner, [two, one], { day: DAY, size: 0 })).toEqual([]);
    expect(roundOrder(owner, [two, one], { day: DAY, size: -1 })).toEqual([]);
  });

  it("never holds the owner, nor anybody out of their pool", () => {
    const sameGender = woman("same");
    const tooOld = { ...man("old"), person: { ...man("old").person, age: 50 } };
    expect(
      ids(roundOrder(owner, [owner, sameGender, tooOld, one], { day: DAY, size: 10 })),
    ).toEqual(["one"]);
  });

  it("is empty when nobody is in the pool", () => {
    expect(roundOrder(owner, [], { day: DAY, size: 10 })).toEqual([]);
  });
});

describe("the liked-you places (#97)", () => {
  const owner = woman("owner", { education: "amk" });
  const first = man("first");
  const second = man("second", { education: "amk" });
  const third = man("third");

  it("keep the order they are given, the oldest like first, whatever the soft matches say", () => {
    expect(ids(likedYouPlaces(owner, [first, second, third], 10))).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("stop at the cap, and are none at a cap of nothing or below it", () => {
    expect(ids(likedYouPlaces(owner, [first, second, third], 2))).toEqual(["first", "second"]);
    expect(likedYouPlaces(owner, [first, second], 0)).toEqual([]);
    expect(likedYouPlaces(owner, [first, second], -1)).toEqual([]);
  });

  it("leave out the owner, anybody out of their pool, and anybody a hidden field keeps apart, before the cap", () => {
    const sameGender = woman("same");
    const hidden = man("hidden", { field: ["tech"] });
    const hiding = woman("hiding", { field: ["tech"], hideFromField: true });
    expect(ids(likedYouPlaces(owner, [owner, sameGender, first], 1))).toEqual(["first"]);
    expect(ids(likedYouPlaces(hiding, [hidden, first], 1))).toEqual(["first"]);
  });
});

describe("ties between equal counts", () => {
  const owner = woman("owner");
  const others = Array.from({ length: 12 }, (_, i) => man(`m${i}`));

  it("are in the same order whenever the day's round is built, whatever order the people come in", () => {
    const once = ids(roundOrder(owner, others, { day: DAY, size: 12 }));
    expect(ids(roundOrder(owner, [...others].reverse(), { day: DAY, size: 12 }))).toEqual(once);
    expect(new Set(once)).toEqual(new Set(ids(others)));
  });

  it("are in another order on another day, and for another owner", () => {
    const today = ids(roundOrder(owner, others, { day: DAY, size: 12 }));
    expect(ids(roundOrder(owner, others, { day: "2026-10-21", size: 12 }))).not.toEqual(today);
    expect(ids(roundOrder(woman("another"), others, { day: DAY, size: 12 }))).not.toEqual(today);
  });

  it("never put fewer matches ahead of more", () => {
    const owner = woman("owner", { education: "amk" });
    const similar = man("similar", { education: "kandi" });
    // Among twelve equal ones, the one similar person is first whatever the day.
    for (const day of ["2026-10-20", "2026-10-21", "2026-12-24"]) {
      expect(ids(roundOrder(owner, [...others, similar], { day, size: 3 }))[0]).toBe("similar");
    }
  });
});

describe("A person who hides from their own field never meets it, asked from either side", () => {
  it.each([
    { aFields: "tech", aHides: "hides", bFields: "tech", bHides: "does not hide", apart: "kept" },
    { aFields: "tech", aHides: "does not hide", bFields: "tech", bHides: "hides", apart: "kept" },
    {
      aFields: "tech,business",
      aHides: "hides",
      bFields: "business",
      bHides: "does not hide",
      apart: "kept",
    },
    { aFields: "tech", aHides: "hides", bFields: "business", bHides: "hides", apart: "not kept" },
    {
      aFields: "tech",
      aHides: "does not hide",
      bFields: "tech",
      bHides: "does not hide",
      apart: "not kept",
    },
    {
      aFields: "nothing",
      aHides: "hides",
      bFields: "tech",
      bHides: "does not hide",
      apart: "not kept",
    },
  ])(
    "$aFields ($aHides) and $bFields ($bHides): $apart",
    ({ aFields, aHides, bFields, bHides, apart }) => {
      const answers = (fields: string, hides: string): ProfileFields => ({
        ...(fields === "nothing" ? {} : { field: fields.split(",") as ProfileFields["field"] }),
        ...(hides === "hides" ? { hideFromField: true } : {}),
      });
      const a = woman("a", answers(aFields, aHides));
      const b = man("b", answers(bFields, bHides));
      const kept = apart === "kept";
      expect(hiddenByField(a.person.fields, b.person.fields)).toBe(kept);
      expect(hiddenByField(b.person.fields, a.person.fields)).toBe(kept);
      // And so the round: nobody's round holds the other while they are kept apart.
      expect(ids(roundOrder(a, [b], { day: DAY, size: 10 }))).toEqual(kept ? [] : ["b"]);
      expect(ids(roundOrder(b, [a], { day: DAY, size: 10 }))).toEqual(kept ? [] : ["a"]);
    },
  );
});

// Any people at all: genders, seeks, ages, intents, soft answers and fields drawn.
const personArb = (id: string): fc.Arbitrary<RoundCandidate> =>
  fc
    .record({
      gender: fc.constantFrom(...GENDERS),
      seeks: fc.uniqueArray(fc.constantFrom(...GENDERS), {
        minLength: 1,
        maxLength: GENDERS.length,
      }),
      age: fc.integer({ min: AGE_MIN, max: AGE_MAX }),
      a: fc.integer({ min: AGE_MIN, max: AGE_MAX }),
      b: fc.integer({ min: AGE_MIN, max: AGE_MAX }),
      intent: fc.constantFrom(...PROFILE_FIELDS.intent.options),
      soft: fc.record(
        Object.fromEntries(
          SOFT.map((key) => {
            const spec = PROFILE_FIELDS[key];
            return [key, fc.constantFrom(...("options" in spec ? spec.options : []))];
          }),
        ),
        { requiredKeys: [] },
      ),
      field: fc.subarray([...FIELDS], { maxLength: 2 }),
      hides: fc.boolean(),
    })
    .map(({ gender, seeks, age, a, b, intent, soft, field, hides }) => ({
      id,
      person: {
        gender,
        seeks,
        ageWindow: { min: Math.min(a, b), max: Math.max(a, b) },
        age,
        intent,
        identityId: `identity-${id}`,
        blocks: new Set<string>(),
        fields: {
          ...soft,
          intent,
          ...(field.length > 0 ? { field } : {}),
          ...(hides ? { hideFromField: true } : {}),
        } as ProfileFields,
        dealBreakers: [],
      } satisfies PoolPerson,
    }));

const crowdArb = fc
  .integer({ min: 0, max: 30 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => personArb(`p${i}`))));

describe("the order, for any people", () => {
  it("holds only people in each other's pool, both ways, kept apart by no field, never the owner (rule 7)", () => {
    fc.assert(
      fc.property(
        personArb("owner"),
        crowdArb,
        fc.integer({ min: 0, max: 15 }),
        (owner, crowd, size) => {
          const round = roundOrder(owner, [owner, ...crowd], { day: DAY, size });
          expect(round.length).toBeLessThanOrEqual(size);
          expect(new Set(ids(round)).size).toBe(round.length);
          for (const candidate of round) {
            expect(candidate.id).not.toBe(owner.id);
            expect(inEachOthersPool(owner.person, candidate.person)).toBe(true);
            expect(inEachOthersPool(candidate.person, owner.person)).toBe(true);
            expect(hiddenByField(owner.person.fields, candidate.person.fields)).toBe(false);
          }
        },
      ),
    );
  });

  it("is everybody who may be shown, up to the size: nobody who may be is left out for a worse one", () => {
    fc.assert(
      fc.property(
        personArb("owner"),
        crowdArb,
        fc.integer({ min: 0, max: 15 }),
        (owner, crowd, size) => {
          const round = roundOrder(owner, crowd, { day: DAY, size });
          const may = crowd.filter(
            (other) =>
              inEachOthersPool(owner.person, other.person) &&
              !hiddenByField(owner.person.fields, other.person.fields),
          );
          expect(round.length).toBe(Math.min(size, may.length));
          const counts = round.map((c) => softMatches(owner.person.fields, c.person.fields));
          // The most soft matches first, and nobody left out who has more than the last one taken.
          expect([...counts].sort((x, y) => y - x)).toEqual(counts);
          const last = counts.at(-1) ?? Number.POSITIVE_INFINITY;
          const taken = new Set(ids(round));
          for (const other of may) {
            if (taken.has(other.id)) continue;
            expect(softMatches(owner.person.fields, other.person.fields)).toBeLessThanOrEqual(last);
          }
        },
      ),
    );
  });

  it("puts first only people in each other's pool, both ways, in the order given, up to the cap (rule 7)", () => {
    fc.assert(
      fc.property(
        personArb("owner"),
        crowdArb,
        fc.integer({ min: 0, max: 15 }),
        (owner, crowd, cap) => {
          const places = likedYouPlaces(owner, crowd, cap);
          expect(places.length).toBeLessThanOrEqual(cap);
          for (const candidate of places) {
            expect(inEachOthersPool(owner.person, candidate.person)).toBe(true);
            expect(inEachOthersPool(candidate.person, owner.person)).toBe(true);
            expect(hiddenByField(owner.person.fields, candidate.person.fields)).toBe(false);
          }
          const order = ids(crowd);
          const at = ids(places).map((id) => order.indexOf(id));
          expect([...at].sort((x, y) => x - y)).toEqual(at);
        },
      ),
    );
  });

  it("is the same whatever order the people come in", () => {
    fc.assert(
      fc.property(personArb("owner"), crowdArb, (owner, crowd) => {
        const once = ids(roundOrder(owner, crowd, { day: DAY, size: 10 }));
        expect(ids(roundOrder(owner, [...crowd].reverse(), { day: DAY, size: 10 }))).toEqual(once);
      }),
    );
  });
});

describe("the order people come back in (#99, ADR-042 §1)", () => {
  const owner = woman("owner");
  const back = (id: string, lastShown: string, passed: boolean): ComingBack => ({
    ...man(id),
    lastShown,
    passed,
  });

  it("brings those left undecided or liked first, then those passed, each shown longest ago first", () => {
    const people = [
      back("passed-later", "2026-07-10", true),
      back("left-later", "2026-09-10", false),
      back("passed-earlier", "2026-06-20", true),
      back("left-earlier", "2026-09-05", false),
    ];
    expect(ids(comingBackOrder(owner, people, { day: DAY, size: 10 }))).toEqual([
      "left-earlier",
      "left-later",
      "passed-earlier",
      "passed-later",
    ]);
  });

  it("orders people shown the same day by the day's hash, the same whenever asked", () => {
    const people = ["x", "y", "z"].map((id) => back(id, "2026-09-01", false));
    const first = ids(comingBackOrder(owner, people, { day: DAY, size: 10 }));
    expect(ids(comingBackOrder(owner, [...people].reverse(), { day: DAY, size: 10 }))).toEqual(
      first,
    );
    expect(first.sort()).toEqual(["x", "y", "z"]);
  });

  it("stops at the size, is empty below one, and holds nobody out of the owner's pool", () => {
    const people = [back("a", "2026-09-01", false), back("b", "2026-09-02", false)];
    expect(ids(comingBackOrder(owner, people, { day: DAY, size: 1 }))).toEqual(["a"]);
    expect(comingBackOrder(owner, people, { day: DAY, size: 0 })).toEqual([]);
    expect(comingBackOrder(owner, people, { day: DAY, size: -2 })).toEqual([]);
    const elsewhere: ComingBack = { ...back("w", "2026-08-01", false), ...woman("w") };
    const self: ComingBack = { ...back("owner", "2026-08-01", false), ...owner };
    expect(comingBackOrder(owner, [elsewhere, self], { day: DAY, size: 10 })).toEqual([]);
  });
});
