import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Applicant,
  admit,
  admitsAlone,
  competeAlike,
  contestsOf,
  joinsAContest,
  neededFrom,
  placeAlone,
  saidInStep,
  sayPlace,
  sayPool,
} from "./gate.ts";

// features/pond/gate.feature (#94, #147, ADR-015): admission and what is said,
// as the pure rules they are. The count over a database is jobs/pond-gate.test.ts.

const T0 = Date.parse("2026-10-01T09:00:00Z");
let serial = 0;

/** People of one kind, each registered a minute after the one before. */
function group(
  count: number,
  gender: Applicant["gender"],
  seeks: Applicant["seeks"],
  options: { admitted?: boolean; from?: number } = {},
): Applicant[] {
  return Array.from({ length: count }, (_, i) => {
    serial += 1;
    return {
      id: `${gender}-${String(serial).padStart(4, "0")}`,
      gender,
      seeks,
      admitted: options.admitted ?? false,
      registeredAt: new Date(T0 + ((options.from ?? serial) + i) * 60_000),
    };
  });
}

const genderArb = fc.constantFrom("woman", "man", "non_binary") as fc.Arbitrary<
  Applicant["gender"]
>;

/** Any pond: people of the three genders seeking any of them, some let in already, registered at any time. */
const applicantsArb = fc
  .array(
    fc.record({
      gender: genderArb,
      seeks: fc.uniqueArray(genderArb, { minLength: 1, maxLength: 3 }),
      admitted: fc.boolean(),
      minute: fc.integer({ min: 0, max: 10_000 }),
    }),
    { maxLength: 60 },
  )
  .map((drawn) =>
    drawn.map(
      (d, i): Applicant => ({
        id: `p-${String(i).padStart(3, "0")}`,
        gender: d.gender,
        seeks: d.seeks,
        admitted: d.admitted,
        registeredAt: new Date(T0 + d.minute * 60_000),
      }),
    ),
  );

const sameContests = (a: Applicant, b: Applicant) =>
  contestsOf(a).join(",") === contestsOf(b).join(",");

describe("admission", () => {
  it("The smaller group is always let in, the larger while it is at most its share", () => {
    const inside = [
      ...group(6, "man", ["woman"], { admitted: true }),
      ...group(4, "woman", ["man"], { admitted: true }),
    ];
    // Seven of eleven would be over the share: both wait.
    const larger = group(2, "man", ["woman"], { from: 100 });
    expect(admit([...inside, ...larger], 0.6)).toEqual({
      admitted: [],
      waiting: new Map([
        [larger[0]?.id, 1],
        [larger[1]?.id, 2],
      ]),
    });
    // One of the smaller group is let in, and seven of twelve is inside the share.
    const smaller = group(1, "woman", ["man"], { from: 200 });
    const { admitted, waiting } = admit([...inside, ...larger, ...smaller], 0.6);
    expect(admitted).toEqual([larger[0]?.id, smaller[0]?.id]);
    expect([...waiting]).toEqual([[larger[1]?.id, 1]]);
  });

  it("A newcomer of the smaller group opens the way for those who waited", () => {
    const inside = group(3, "man", ["woman"], { admitted: true });
    const waited = group(2, "man", ["woman"], { from: 100 });
    // Three and three are equal, so the one who waited longest follows; five of eight would be over the share.
    const newcomers = group(3, "woman", ["man"], { from: 200 });
    const { admitted, waiting } = admit([...inside, ...waited, ...newcomers], 0.6);
    expect(admitted).toEqual([waited[0]?.id, ...newcomers.map((p) => p.id)]);
    expect([...waiting]).toEqual([[waited[1]?.id, 1]]);
  });

  it("People who compete for nobody never wait, and seeking one's own gender too opens no door", () => {
    const inside = [
      ...group(9, "man", ["woman"], { admitted: true }),
      ...group(1, "woman", ["man"], { admitted: true }),
    ];
    const own = group(1, "man", ["man"], { from: 100 });
    const both = group(1, "man", ["woman", "man"], { from: 101 });
    const waits = group(1, "man", ["woman"], { from: 102 });
    const { admitted, waiting } = admit([...inside, ...own, ...both, ...waits], 0.6);
    expect(admitted).toEqual([own[0]?.id]);
    expect([...waiting]).toEqual([
      [both[0]?.id, 1],
      [waits[0]?.id, 2],
    ]);
    expect(contestsOf(own[0] as Applicant)).toEqual([]);
    expect(contestsOf(both[0] as Applicant)).toEqual(["woman"]);
    expect(contestsOf(waits[0] as Applicant)).toEqual(["woman"]);
  });

  it("A person competes for whom they seek, whatever label they chose for themselves", () => {
    // Six men and four women seeking each other: the contest for women is at its ratio (three to two).
    const inside = [
      ...group(6, "man", ["woman"], { admitted: true }),
      ...group(4, "woman", ["man"], { admitted: true }),
    ];
    const they = group(1, "non_binary", ["woman"], { from: 100 });
    const he = group(1, "man", ["woman"], { from: 101 });
    const { admitted, waiting } = admit([...inside, ...they, ...he], 0.6);
    expect(admitted).toEqual([]);
    expect([...waiting]).toEqual([
      [they[0]?.id, 1],
      [he[0]?.id, 2],
    ]);
    expect(competeAlike(they[0] as Applicant, he[0] as Applicant)).toBe(true);
    // One more woman makes room for one: the one who registered first, whoever they are.
    const her = group(1, "woman", ["man"], { from: 102 });
    expect(admit([...inside, ...they, ...he, ...her], 0.6).admitted).toEqual([
      they[0]?.id,
      her[0]?.id,
    ]);
  });

  it("Nobody is let out again when the pond drifts", () => {
    // Eight of one group and one of the other, all let in: far over the share, and it stays so.
    const inside = [
      ...group(8, "woman", ["man"], { admitted: true }),
      ...group(1, "man", ["woman"], { admitted: true }),
    ];
    const { admitted, waiting } = admit(inside, 0.6);
    expect(admitted).toEqual([]);
    expect(waiting.size).toBe(0);
  });

  it("an empty pond lets the first in, of whichever group, and the first of the other", () => {
    const first = group(1, "man", ["woman"], { from: 1 });
    const second = group(1, "man", ["woman"], { from: 2 });
    const other = group(1, "woman", ["man"], { from: 3 });
    expect(admit([...first, ...second], 0.6)).toEqual({
      admitted: [first[0]?.id],
      waiting: new Map([[second[0]?.id, 1]]),
    });
    // With one of the other group there, the two are equal and the second follows.
    expect(admit([...first, ...second, ...other], 0.6).admitted).toEqual([
      first[0]?.id,
      second[0]?.id,
      other[0]?.id,
    ]);
  });

  it("does the same for either group: the rule names no gender", () => {
    const swap = (people: Applicant[]): Applicant[] =>
      people.map((p) => ({
        ...p,
        id: `swapped-${p.id}`,
        gender: p.gender === "woman" ? "man" : p.gender === "man" ? "woman" : p.gender,
        seeks: p.seeks.map((g) => (g === "woman" ? "man" : g === "man" ? "woman" : g)),
      }));
    const people = [
      ...group(5, "man", ["woman"], { admitted: true }),
      ...group(3, "woman", ["man"], { admitted: true }),
      ...group(4, "man", ["woman"], { from: 100 }),
      ...group(2, "woman", ["man"], { from: 200 }),
    ];
    const one = admit(people, 0.6);
    const other = admit(swap(people), 0.6);
    expect(other.admitted).toEqual(one.admitted.map((id) => `swapped-${id}`));
    expect([...other.waiting]).toEqual([...one.waiting].map(([id, n]) => [`swapped-${id}`, n]));
  });

  it("a contest standing at exactly its ratio has room for the one more the share allows", () => {
    // Four women competed for by five, the share three to two: the sixth competitor is the
    // ratio exactly. In floating point 0.6 / 0.4 fell short of 1.5 and he waited (#216).
    const women = group(4, "woman", ["non_binary"]);
    const others = group(5, "non_binary", ["woman"]);
    const man = group(1, "man", ["woman"]);
    const { admitted, waiting } = admit([...women, ...others, ...man], 0.6);
    expect(waiting.size).toBe(0);
    expect(admitted).toHaveLength(10);
  });

  it("for any pond: everybody is let in or waits, nobody twice, and nobody who was in is touched", () => {
    fc.assert(
      fc.property(applicantsArb, (people) => {
        const { admitted, waiting } = admit(people, 0.6);
        const fresh = people.filter((p) => !p.admitted).map((p) => p.id);
        expect([...admitted, ...waiting.keys()].sort()).toEqual(fresh.sort());
        expect(new Set(admitted).size).toBe(admitted.length);
      }),
    );
  });

  it("for any pond: among people of the same contests nobody is let in before somebody who registered earlier", () => {
    fc.assert(
      fc.property(applicantsArb, (people) => {
        const { admitted, waiting } = admit(people, 0.6);
        const byId = new Map(people.map((p) => [p.id, p]));
        for (const waits of waiting.keys()) {
          const w = byId.get(waits) as Applicant;
          for (const id of admitted) {
            const a = byId.get(id) as Applicant;
            if (!sameContests(a, w)) continue;
            expect(a.registeredAt.getTime()).toBeLessThanOrEqual(w.registeredAt.getTime());
          }
        }
      }),
    );
  });

  it("for any pond: counting again, with those let in now inside, lets nobody else in", () => {
    fc.assert(
      fc.property(applicantsArb, (people) => {
        const first = admit(people, 0.6);
        const now = new Set(first.admitted);
        const again = admit(
          people.map((p) => (now.has(p.id) ? { ...p, admitted: true } : p)),
          0.6,
        );
        expect(again.admitted).toEqual([]);
        expect([...again.waiting]).toEqual([...first.waiting]);
      }),
    );
  });

  it("for any pond: whoever waits would put a contest of theirs over its ratio", () => {
    fc.assert(
      fc.property(applicantsArb, (people) => {
        const { admitted, waiting } = admit(people, 0.6);
        const inside = new Set([...people.filter((p) => p.admitted).map((p) => p.id), ...admitted]);
        const competitors = { woman: 0, man: 0, non_binary: 0 };
        const supply = { woman: 0, man: 0, non_binary: 0 };
        for (const p of people) {
          if (!inside.has(p.id)) continue;
          const contests = contestsOf(p);
          for (const gender of contests) competitors[gender] += 1;
          if (contests.length > 0) supply[p.gender] += 1;
        }
        const byId = new Map(people.map((p) => [p.id, p]));
        for (const id of waiting.keys()) {
          const contests = contestsOf(byId.get(id) as Applicant);
          if (contests.length === 0) throw new Error("somebody waits who competes for nobody");
          const full = contests.some(
            (gender) =>
              competitors[gender] > supply[gender] &&
              competitors[gender] + 1 > 1.5 * supply[gender],
          );
          expect(full).toBe(true);
        }
      }),
    );
  });
});

describe("a first ask", () => {
  const inside = [
    ...group(3, "man", ["woman"], { admitted: true }),
    ...group(3, "woman", ["man"], { admitted: true }),
  ];

  it("lets in who competes for nobody, whoever else is there, and whom a contest has room for", () => {
    const crowd = group(9, "man", ["woman"], { from: 100 });
    const own = group(1, "man", ["man"], { from: 200 });
    // Competes for men, with the three women inside: three for three, room.
    const nonBinary = group(1, "non_binary", ["man"], { from: 201 });
    // Competes for women, behind the nine men of the crowd: no.
    const both = group(1, "man", ["woman", "man"], { from: 202 });
    const people = [...inside, ...crowd, ...own, ...nonBinary, ...both];
    expect(admitsAlone(people, own[0]?.id as string, 0.6)).toBe(true);
    expect(admitsAlone(people, nonBinary[0]?.id as string, 0.6)).toBe(true);
    expect(admitsAlone(people, both[0]?.id as string, 0.6)).toBe(false);
  });

  it("lets in the first of a group when the group may enter as the admissions stand", () => {
    const first = group(1, "man", ["woman"], { from: 100 });
    expect(admitsAlone([...inside, ...first], first[0]?.id as string, 0.6)).toBe(true);
  });

  it("lets nobody pass somebody of their group who registered before them", () => {
    const earlier = group(1, "man", ["woman"], { from: 100 });
    const later = group(1, "man", ["woman"], { from: 200 });
    const women = group(2, "woman", ["man"], { from: 150 });
    const people = [...inside, ...earlier, ...women, ...later];
    // Counted together both are let in.
    expect(admit(people, 0.6).admitted).toContain(later[0]?.id);
    expect(admitsAlone(people, later[0]?.id as string, 0.6)).toBe(false);
    expect(admitsAlone(people, earlier[0]?.id as string, 0.6)).toBe(true);
  });

  it("lets nobody in through room that somebody not let in would make", () => {
    const four = group(1, "man", ["woman"], { admitted: true });
    const newcomer = group(1, "woman", ["man"], { from: 100 });
    const he = group(1, "man", ["woman"], { from: 200 });
    // Four men and three women are inside. With her he would be the fifth of nine.
    const people = [...inside, ...four, ...newcomer, ...he];
    expect(admit(people, 0.6).admitted).toContain(he[0]?.id);
    expect(admitsAlone(people, he[0]?.id as string, 0.6)).toBe(false);
    // She is of the smaller group and needs nobody.
    expect(admitsAlone(people, newcomer[0]?.id as string, 0.6)).toBe(true);
  });

  it("says the place behind everybody of the group who is not let in, whoever a count would let in", () => {
    const recorded = [
      ...group(6, "man", ["woman"], { admitted: true }),
      ...group(4, "woman", ["man"], { admitted: true }),
    ];
    const women = group(3, "woman", ["man"], { from: 100 });
    const men = group(12, "man", ["woman"], { from: 200 });
    const people = [...recorded, ...women, ...men];
    const last = men[11]?.id as string;
    // Counted together the three women make room for four of the men: the last is eighth.
    expect(admit(people, 0.6).waiting.get(last)).toBe(8);
    // As the admissions stand eleven stand before him.
    expect(placeAlone(people, last)).toBe(12);
    expect(sayPlace(placeAlone(people, last) as number, 10)).toBe(20);
    expect(placeAlone(people, men[0]?.id as string)).toBe(1);
    // Somebody who competes for nobody has no place in any line.
    const own = group(1, "man", ["man"], { from: 300 });
    expect(placeAlone([...people, ...own], own[0]?.id as string)).toBeNull();
  });

  it("for any pond: a place on a first ask is never better than the place of the count", () => {
    fc.assert(
      fc.property(applicantsArb, (people) => {
        for (const [id, place] of admit(people, 0.6).waiting) {
          expect(placeAlone(people, id)).toBeGreaterThanOrEqual(place);
        }
      }),
    );
  });

  it("for any pond: whoever a first ask lets in, counting everybody lets in too, and passes nobody", () => {
    fc.assert(
      fc.property(applicantsArb, (people) => {
        const together = new Set(admit(people, 0.6).admitted);
        for (const person of people) {
          if (person.admitted || !admitsAlone(people, person.id, 0.6)) continue;
          expect(together.has(person.id)).toBe(true);
          if (contestsOf(person).length === 0) continue;
          for (const other of people) {
            if (other.admitted || other.id === person.id || !competeAlike(other, person)) continue;
            const before =
              other.registeredAt.getTime() < person.registeredAt.getTime() ||
              (other.registeredAt.getTime() === person.registeredAt.getTime() &&
                other.id < person.id);
            expect(before).toBe(false);
          }
        }
      }),
    );
  });
});

describe("what is said", () => {
  it("What a person is told is said in tens, and follows slowly", () => {
    // A pool of seventeen is said as ten: about twenty more are needed of thirty.
    expect(sayPool(null, 17, 10)).toBe(10);
    expect(neededFrom(10, 30)).toBe(20);
    // Two more come: nineteen is ten still.
    expect(sayPool(10, 19, 10)).toBe(10);
    // The twentieth makes it twenty, and about ten more are needed.
    expect(sayPool(10, 20, 10)).toBe(20);
    expect(neededFrom(sayPool(10, 20, 10), 30)).toBe(10);
    // One of them leaves again: a pool that goes back over the ten does not show it.
    expect(sayPool(20, 19, 10)).toBe(20);
    expect(sayPool(20, 11, 10)).toBe(20);
    // A whole step away, it follows.
    expect(sayPool(20, 10, 10)).toBe(10);
    expect(sayPool(20, 3, 10)).toBe(0);
  });

  it("The place in the line is said in tens", () => {
    expect(sayPlace(1, 10)).toBe(10);
    expect(sayPlace(10, 10)).toBe(10);
    expect(sayPlace(11, 10)).toBe(20);
    expect(sayPlace(37, 10)).toBe(40);
    // Never less than the first ten, whatever comes in.
    expect(sayPlace(0, 10)).toBe(10);
  });

  it("the first figure is rounded like every later one", () => {
    expect(sayPool(null, 0, 10)).toBe(0);
    expect(sayPool(null, 1, 10)).toBe(0);
    expect(sayPool(null, 9, 10)).toBe(0);
    expect(sayPool(null, 29, 10)).toBe(20);
  });

  it("a figure said under another step is read in the step of today, and followed from there", () => {
    // Twenty was said under a step of ten, and the pool fell to fifteen since:
    // less than a step, so twenty stands. The step is raised to twenty.
    expect(saidInStep(20, 20)).toBe(20);
    expect(sayPool(20, 15, 20)).toBe(20);
    // A fresh figure would say none, and with it that the pool fell below twenty.
    expect(sayPool(null, 15, 20)).toBe(0);
    // Ten under a step of ten is none under a step of twenty, whatever the pool within a step.
    expect(saidInStep(10, 20)).toBe(0);
    expect(sayPool(10, 19, 20)).toBe(0);
    // A whole new step away, it follows.
    expect(sayPool(10, 35, 20)).toBe(20);
    // Lowered again, a figure of the coarser step is one of the finer, and stands.
    expect(saidInStep(20, 10)).toBe(20);
    expect(sayPool(20, 15, 10)).toBe(20);
    expect(sayPool(20, 25, 10)).toBe(20);
    expect(sayPool(20, 30, 10)).toBe(30);
    // Steps that are no multiples of one another are read down all the same.
    expect(saidInStep(20, 15)).toBe(15);
    expect(saidInStep(15, 10)).toBe(10);
  });

  it("for any figures: what was said under another step is read down to this one, and stands while the pool is within a step", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 10, max: 50 }),
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 10, max: 50 }),
        (steps, stepThen, pool, step) => {
          const said = steps * stepThen;
          const from = saidInStep(said, step);
          expect(from % step).toBe(0);
          expect(from).toBeLessThanOrEqual(said);
          expect(said - from).toBeLessThan(step);
          const now = sayPool(said, pool, step);
          expect(now % step).toBe(0);
          expect([from, Math.floor(pool / step) * step]).toContain(now);
          expect(Math.abs(pool - now)).toBeLessThan(step);
          if (Math.abs(pool - from) < step) expect(now).toBe(from);
        },
      ),
    );
  });

  it("at least one more is needed while the gate is closed, whatever was said", () => {
    expect(neededFrom(20, 30)).toBe(10);
    expect(neededFrom(30, 30)).toBe(1);
    expect(neededFrom(40, 30)).toBe(1);
    expect(neededFrom(0, 29.5)).toBe(30);
  });

  it("for any figures: what is said is a whole number of steps, never above the pool by a step or more", () => {
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: 0, max: 50 }), { nil: null }),
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 10, max: 50 }),
        (steps, pool, step) => {
          const said = steps === null ? null : steps * step;
          const now = sayPool(said, pool, step);
          expect(now % step).toBe(0);
          expect([said, Math.floor(pool / step) * step]).toContain(now);
          expect(Math.abs(pool - now)).toBeLessThan(2 * step);
        },
      ),
    );
  });

  it("for any pool: no two pools within one step of tens are told apart by a first figure", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 0, max: 9 }),
        fc.integer({ min: 0, max: 9 }),
        (tens, a, b) => {
          expect(sayPool(null, tens * 10 + a, 10)).toBe(sayPool(null, tens * 10 + b, 10));
        },
      ),
    );
  });

  it("for any place: it is said as the end of its ten", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 10, max: 50 }),
        (place, step) => {
          const said = sayPlace(place, step);
          expect(said % step).toBe(0);
          expect(said).toBeGreaterThanOrEqual(place);
          expect(said - place).toBeLessThan(step);
        },
      ),
    );
  });
});

describe("a change of what a person declares", () => {
  const man = (seeks: string[]) => ({ gender: "man", seeks });

  it("joining a contest is a reason to decide anew, leaving one is not", () => {
    // From one contest to another.
    expect(joinsAContest({ gender: "woman", seeks: ["man"] }, man(["woman"]))).toBe(true);
    // One contest more.
    expect(joinsAContest(man(["woman"]), man(["woman", "non_binary"]))).toBe(true);
    expect(joinsAContest(man(["man"]), man(["man", "woman"]))).toBe(true);
    // Out of a contest, to where nobody waits.
    expect(joinsAContest(man(["woman", "non_binary"]), man(["woman"]))).toBe(false);
    expect(joinsAContest(man(["woman"]), man(["man"]))).toBe(false);
  });

  it("one's own gender is no contest, and a label that keeps the contests changes nothing", () => {
    expect(joinsAContest(man(["woman"]), man(["woman", "man"]))).toBe(false);
    expect(joinsAContest(man(["woman", "man"]), man(["woman"]))).toBe(false);
    expect(joinsAContest({ gender: "non_binary", seeks: ["woman"] }, man(["woman"]))).toBe(false);
    expect(joinsAContest(man(["woman"]), { gender: "non_binary", seeks: ["woman"] })).toBe(false);
    expect(joinsAContest(man(["woman"]), man(["woman"]))).toBe(false);
  });

  it("a first declaration is a joining, and an unfinished one is none", () => {
    expect(joinsAContest({ gender: null, seeks: null }, man(["woman"]))).toBe(true);
    expect(joinsAContest({ gender: "man", seeks: null }, man(["woman"]))).toBe(true);
    expect(joinsAContest(man(["woman"]), { gender: "man", seeks: null })).toBe(false);
    expect(joinsAContest(man(["woman"]), { gender: null, seeks: ["woman"] })).toBe(false);
  });
});
