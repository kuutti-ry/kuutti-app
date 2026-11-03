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
import { addDays } from "../lib/finnish-day.ts";
import { bandBetween, inEachOthersPool, type PoolHome, type PoolPerson } from "./pool.ts";
import {
  type ComingBack,
  comingBackOrder,
  hiddenByField,
  likedYouPlaces,
  mayMeet,
  type Return,
  type RoundCandidate,
  roundOrder,
} from "./round-order.ts";
import { softMatches } from "./soft.ts";

// The order of the queue past the likes waiting (#95, #502, ADR-035, ADR-062 §2;
// features/matching/rounds.feature): the pool both ways, a hidden field, the
// nearest band first, then the soft matches, ties in an order of the day's and
// the owner's, and the four groups people come back in. The builder over a
// database is jobs/round-builder.test.ts.

const DAY = "2026-10-20";
const FIELDS = PROFILE_FIELDS.field.options;
const SOFT = PROFILE_FIELD_KEYS.filter(
  (key) => PROFILE_FIELDS[key].preferenceAbout === "soft" && PROFILE_FIELDS[key].kind === "single",
);

const EDGES = { nearby: 5, close: 15, around: 50 };
/** A home this many kilometres along one line; everybody of these tests lives at 0 unless told. */
const homeAt = (km: number): PoolHome => ({ x: km * 1000, y: 0, edges: EDGES });
const livingAt = <T extends RoundCandidate>(candidate: T, km: number): T => ({
  ...candidate,
  person: { ...candidate.person, home: homeAt(km) },
});

/** A woman of 30 who seeks men of 25 to 40, open to either, with these answers. */
const woman = (id: string, fields: ProfileFields = {}): RoundCandidate => ({
  id,
  person: {
    gender: "woman",
    seeks: ["man"],
    ageWindow: { min: 25, max: 40 },
    age: 30,
    intent: "open_to_either",
    home: homeAt(0),
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

describe("the order of new people", () => {
  const owner = woman("owner", { education: "amk", drinking: "rarely", drugsAttitude: "never" });
  // Similar on two soft fields, on one, on none (the step next door is similar, ADR-019 §1).
  const two = man("two", { education: "kandi", drinking: "never", drugsAttitude: "often" });
  const one = man("one", { education: "amk", drinking: "often" });
  const none = man("none", {});

  it("Within a band the most soft matches come first", () => {
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

describe("the nearest band (ADR-061 §6)", () => {
  const owner = woman("owner", {
    education: "amk",
    drinking: "rarely",
    drugsAttitude: "not_my_thing",
  });
  /** Similar to the owner on `n` of the three soft fields. */
  const similar = (id: string, n: number) =>
    man(id, {
      ...(n >= 1 ? { education: "amk" as const } : {}),
      ...(n >= 2 ? { drinking: "rarely" as const } : {}),
      ...(n >= 3 ? { drugsAttitude: "not_my_thing" as const } : {}),
    });

  it("The nearest band comes first, then the most soft matches, then the day's order", () => {
    const b = livingAt(similar("b", 3), 400);
    const c = livingAt(similar("c", 1), 10);
    const d = livingAt(similar("d", 2), 10);
    const e = livingAt(similar("e", 0), 1);
    expect(softMatches(owner.person.fields, b.person.fields)).toBe(3);
    expect(ids(roundOrder(owner, [b, c, d, e], { day: DAY, size: 10 }))).toEqual([
      "e",
      "d",
      "c",
      "b",
    ]);
    // Level on both, two stand in an order of the day's and the owner's: the same when asked again.
    const level = [livingAt(similar("x", 1), 10), livingAt(similar("y", 1), 12)];
    const today = ids(roundOrder(owner, level, { day: DAY, size: 2 }));
    expect(ids(roundOrder(owner, [...level].reverse(), { day: DAY, size: 2 }))).toEqual(today);
    const orders = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"].map(
      (day) => ids(roundOrder(owner, level, { day, size: 2 })).join(),
    );
    expect(new Set(orders).size).toBe(2);
  });

  it("puts a nearer band ahead of any soft count, and cuts at the size from the far end", () => {
    const near = livingAt(similar("near", 0), 0);
    const close = livingAt(similar("close", 1), 6);
    const around = livingAt(similar("around", 2), 20);
    const far = livingAt(similar("far", 3), 60);
    expect(ids(roundOrder(owner, [far, around, close, near], { day: DAY, size: 3 }))).toEqual([
      "near",
      "close",
      "around",
    ]);
  });

  it("reads the band from the owner's home, whoever the candidates are near", () => {
    const candidates = [livingAt(man("a"), 0), livingAt(man("b"), 200)];
    expect(ids(roundOrder(livingAt(owner, 195), candidates, { day: DAY, size: 2 }))).toEqual([
      "b",
      "a",
    ]);
  });

  it("is told by the edges the home carries, whatever order they stand in", () => {
    const shifted = (candidate: RoundCandidate, km: number): RoundCandidate => ({
      ...candidate,
      person: {
        ...candidate.person,
        home: { ...homeAt(km), edges: { nearby: 1, close: 2, around: 3 } },
      },
    });
    const here = shifted(owner, 0);
    expect(bandBetween(here.person.home, shifted(man("a"), 4).person.home)).toBe("far");
    expect(
      ids(
        roundOrder(here, [shifted(man("a"), 4), shifted(man("b"), 0.5)], {
          day: DAY,
          size: 2,
        }),
      ),
    ).toEqual(["b", "a"]);
    const unordered = { nearby: 15, close: 5, around: 50 };
    expect(bandBetween({ ...homeAt(0), edges: unordered }, homeAt(10))).toBe("nearby");
  });

  it("moves neither the liked-you places nor the order of coming back", () => {
    const far = livingAt(man("far"), 900);
    const near = livingAt(man("near"), 0);
    expect(ids(likedYouPlaces(owner, [far, near]))).toEqual(["far", "near"]);
    const back = (candidate: RoundCandidate, lastShown: string): ComingBack => ({
      ...candidate,
      lastShown,
      from: "skipped",
    });
    expect(
      ids(
        comingBackOrder(owner, [back(far, "2026-09-01"), back(near, "2026-09-05")], {
          day: DAY,
          size: 2,
        }),
      ),
    ).toEqual(["far", "near"]);
  });
});

describe("the liked-you places (#97)", () => {
  const owner = woman("owner", { education: "amk" });
  const first = man("first");
  const second = man("second", { education: "amk" });
  const third = man("third");

  it("keep the order they are given, the oldest like first, whatever the soft matches say", () => {
    expect(ids(likedYouPlaces(owner, [first, second, third]))).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("are all of them, however many wait", () => {
    const many = Array.from({ length: 60 }, (_, i) => man(`m${i}`));
    expect(ids(likedYouPlaces(owner, many))).toEqual(ids(many));
  });

  it("leave out the owner, anybody out of their pool, and anybody a hidden field keeps apart", () => {
    const sameGender = woman("same");
    const hidden = man("hidden", { field: ["tech"] });
    const hiding = woman("hiding", { field: ["tech"], hideFromField: true });
    expect(ids(likedYouPlaces(owner, [owner, sameGender, first]))).toEqual(["first"]);
    expect(ids(likedYouPlaces(hiding, [hidden, first]))).toEqual(["first"]);
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
        home: homeAt(0),
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

  it("puts first only people in each other's pool, both ways, in the order given (rule 7)", () => {
    fc.assert(
      fc.property(personArb("owner"), crowdArb, (owner, crowd) => {
        const places = likedYouPlaces(owner, crowd);
        for (const candidate of places) {
          expect(inEachOthersPool(owner.person, candidate.person)).toBe(true);
          expect(inEachOthersPool(candidate.person, owner.person)).toBe(true);
          expect(hiddenByField(owner.person.fields, candidate.person.fields)).toBe(false);
        }
        const order = ids(crowd);
        const at = ids(places).map((id) => order.indexOf(id));
        expect([...at].sort((x, y) => x - y)).toEqual(at);
      }),
    );
  });

  it("asks the same of the two whichever of them is asked (rule 7)", () => {
    fc.assert(
      fc.property(personArb("a"), personArb("b"), (a, b) => {
        expect(mayMeet(a, b)).toBe(mayMeet(b, a));
      }),
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

describe("the order, for any homes (ADR-061 §6)", () => {
  /** The band's place in the order and the soft count, nearest and most first. */
  const standing = (owner: RoundCandidate, candidate: RoundCandidate) =>
    [
      ["nearby", "close", "around", "far"].indexOf(
        bandBetween(owner.person.home, candidate.person.home),
      ),
      -softMatches(owner.person.fields, candidate.person.fields),
    ] as const;

  it("never puts a further band ahead of a nearer one, nor within a band fewer matches ahead of more", () => {
    fc.assert(
      fc.property(
        personArb("owner"),
        crowdArb,
        fc.array(fc.integer({ min: 0, max: 80 }), { minLength: 30, maxLength: 30 }),
        (owner, crowd, kms) => {
          const placed = crowd.map((candidate, i) => livingAt(candidate, kms[i] ?? 0));
          const round = roundOrder(owner, placed, { day: DAY, size: 30 });
          for (const [i, candidate] of round.entries()) {
            const next = round[i + 1];
            if (!next) break;
            const [band, count] = standing(owner, candidate);
            const [nextBand, nextCount] = standing(owner, next);
            expect(band).toBeLessThanOrEqual(nextBand);
            if (band === nextBand) expect(count).toBeLessThanOrEqual(nextCount);
          }
        },
      ),
      { seed: 514 },
    );
  });
});

describe("the order people come back in (#99, ADR-042 §1, ADR-062 §2)", () => {
  const owner = woman("owner");
  const back = (id: string, lastShown: string, from: Return): ComingBack => ({
    ...man(id),
    lastShown,
    from,
  });

  it("brings the skipped first, then the passed, then the liked, then former conversations, each shown longest ago first", () => {
    const people = [
      back("ended-later", "2026-05-02", "ended"),
      back("liked-later", "2026-06-02", "liked"),
      back("passed-later", "2026-07-10", "passed"),
      back("skipped-later", "2026-10-10", "skipped"),
      back("ended-earlier", "2026-05-01", "ended"),
      back("liked-earlier", "2026-06-01", "liked"),
      back("passed-earlier", "2026-06-20", "passed"),
      back("skipped-earlier", "2026-10-05", "skipped"),
    ];
    expect(ids(comingBackOrder(owner, people, { day: DAY, size: 10 }))).toEqual([
      "skipped-earlier",
      "skipped-later",
      "passed-earlier",
      "passed-later",
      "liked-earlier",
      "liked-later",
      "ended-earlier",
      "ended-later",
    ]);
  });

  it("keeps the groups whatever the days say: the oldest former conversation comes after the newest skip", () => {
    const people = [back("ended", "2025-01-01", "ended"), back("skipped", "2026-10-19", "skipped")];
    expect(ids(comingBackOrder(owner, people, { day: DAY, size: 10 }))).toEqual([
      "skipped",
      "ended",
    ]);
  });

  it("orders people shown the same day by the day's hash, the same whenever asked", () => {
    const people = ["x", "y", "z"].map((id) => back(id, "2026-09-01", "skipped"));
    const first = ids(comingBackOrder(owner, people, { day: DAY, size: 10 }));
    expect(ids(comingBackOrder(owner, [...people].reverse(), { day: DAY, size: 10 }))).toEqual(
      first,
    );
    expect(first.sort()).toEqual(["x", "y", "z"]);
  });

  it("for any people keeps the groups, and within a group the one shown longest ago first", () => {
    const groups: Return[] = ["skipped", "passed", "liked", "ended"];
    const shown = fc.record({
      from: fc.constantFrom(...groups),
      days: fc.integer({ min: 0, max: 400 }),
    });
    fc.assert(
      fc.property(fc.array(shown, { maxLength: 30 }), (rows) => {
        const others = rows.map(({ from, days }, i) => back(`p${i}`, addDays(DAY, -days), from));
        const order = comingBackOrder(owner, others, { day: DAY, size: others.length });
        expect(order).toHaveLength(others.length);
        for (const [i, person] of order.entries()) {
          const next = order[i + 1];
          if (!next) break;
          const [rank, nextRank] = [groups.indexOf(person.from), groups.indexOf(next.from)];
          expect(rank).toBeLessThanOrEqual(nextRank);
          if (rank === nextRank) {
            expect(person.lastShown <= next.lastShown).toBe(true);
          }
        }
      }),
      { seed: 502 },
    );
  });

  it("stops at the size, is empty below one, and holds nobody out of the owner's pool", () => {
    const people = [back("a", "2026-09-01", "skipped"), back("b", "2026-09-02", "skipped")];
    expect(ids(comingBackOrder(owner, people, { day: DAY, size: 1 }))).toEqual(["a"]);
    expect(comingBackOrder(owner, people, { day: DAY, size: 0 })).toEqual([]);
    expect(comingBackOrder(owner, people, { day: DAY, size: -2 })).toEqual([]);
    const elsewhere: ComingBack = { ...back("w", "2026-08-01", "passed"), ...woman("w") };
    const self: ComingBack = { ...back("owner", "2026-08-01", "passed"), ...owner };
    expect(comingBackOrder(owner, [elsewhere, self], { day: DAY, size: 10 })).toEqual([]);
  });
});
