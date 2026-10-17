import { AGE_BANDS } from "@kuutti/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Cell,
  COARSE_AGE_BAND,
  cellKey,
  census,
  generalise,
  type Released,
  remember,
  WITHHELD,
} from "./copy-census.ts";

// The research copy's census (ADR-029 §4): what is released, under which
// value, and why k holds across the whole copy and not only on one day.

const SEEDED = { seed: 20261017 };
const K = 10;
/** Every pseudonym counts: the census on its own, before copy.ts says whose consent is live. */
const everyone = () => true;

type Row = { researchId: string; cell: Cell; n: number };

const cell = (over: Partial<Omit<Cell, "fields">> & { intent?: string | null } = {}): Cell => ({
  pond: over.pond === undefined ? "otaniemi" : over.pond,
  ageBand: over.ageBand ?? "25-29",
  gender: over.gender === undefined ? "woman" : over.gender,
  fields: { intent: over.intent === undefined ? "long_term" : over.intent },
});

let serial = 0;
/** `count` people, one row each, in one cell; the ids are new unless given. */
function rows(count: number, at: Cell, ids?: string[]): Row[] {
  return Array.from({ length: count }, (_, i) => {
    serial += 1;
    return { researchId: ids?.[i] ?? `person-${serial}`, cell: at, n: serial };
  });
}

const keysOf = (released: Row[]) => [...new Set(released.map((r) => cellKey(r.cell)))];

describe("generalising a cell", () => {
  it("withholds the fields, then coarsens the band, then withholds the pond, and keeps the gender", () => {
    const exact = cell({ pond: "otaniemi", ageBand: "35-39", gender: null, intent: null });
    expect(generalise(exact, 0)).toBe(exact);
    expect(generalise(exact, 1)).toEqual({
      pond: "otaniemi",
      ageBand: "35-39",
      gender: null,
      fields: { intent: WITHHELD },
    });
    expect(generalise(exact, 2)).toMatchObject({ ageBand: "30-39", pond: "otaniemi" });
    expect(generalise(exact, 3)).toEqual({
      pond: WITHHELD,
      ageBand: "30-39",
      gender: null,
      fields: { intent: WITHHELD },
    });
  });

  it("pairs every band with a fixed neighbour, a decade or more wide", () => {
    expect(AGE_BANDS.map((band) => COARSE_AGE_BAND[band])).toEqual([
      "18-29",
      "18-29",
      "30-39",
      "30-39",
      "40+",
      "40+",
    ]);
  });

  it("keeps null and withheld apart: not chosen is not withheld", () => {
    expect(cellKey(cell({ pond: null }))).not.toBe(cellKey(cell({ pond: WITHHELD })));
    expect(cellKey(cell({ intent: null }))).not.toBe(cellKey(cell({ intent: WITHHELD })));
    // A field the cell does not name reads as unanswered.
    expect(cellKey({ ...cell({ intent: null }), fields: {} })).toBe(
      cellKey(cell({ intent: null })),
    );
  });
});

describe("the census of one day", () => {
  it("releases a cell of exactly k people as it is", () => {
    const result = census(rows(K, cell()), new Map(), K, everyone);
    expect(result.released).toHaveLength(K);
    expect(keysOf(result.released)).toEqual([cellKey(cell())]);
    expect(result).toMatchObject({ generalised: 0, dropped: 0 });
  });

  it("withholds the fields of a cell of k − 1 when that reaches k", () => {
    const today = [...rows(K - 1, cell()), ...rows(1, cell({ intent: "casual" }))];
    const result = census(today, new Map(), K, everyone);
    expect(keysOf(result.released)).toEqual([cellKey(generalise(cell(), 1))]);
    expect(result).toMatchObject({ generalised: K, dropped: 0 });
  });

  it("coarsens the band next, then withholds the pond", () => {
    const bands = [...rows(5, cell({ ageBand: "18-24" })), ...rows(5, cell({ ageBand: "25-29" }))];
    expect(keysOf(census(bands, new Map(), K, everyone).released)).toEqual([
      cellKey(cell({ ageBand: "18-29", intent: WITHHELD })),
    ]);
    const ponds = [...rows(5, cell({ pond: "otaniemi" })), ...rows(5, cell({ pond: null }))];
    expect(keysOf(census(ponds, new Map(), K, everyone).released)).toEqual([
      cellKey(cell({ pond: WITHHELD, ageBand: "18-29", intent: WITHHELD })),
    ]);
  });

  it("drops what is still under k, and counts it", () => {
    const result = census(rows(K - 1, cell()), new Map(), K, everyone);
    expect(result).toEqual({ released: [], generalised: 0, dropped: K - 1 });
  });

  it("counts people, not rows: twenty events of one person are one", () => {
    const one = rows(20, cell(), Array(20).fill("the-same-person"));
    const result = census([...one, ...rows(K - 2, cell())], new Map(), K, everyone);
    expect(result.released).toEqual([]);
    expect(result.dropped).toBe(20 + K - 2);
  });

  it("never withholds the gender: a gender under k in the coarsest cell is left out", () => {
    const today = [...rows(K, cell({ gender: "man" })), ...rows(3, cell({ gender: null }))];
    const result = census(today, new Map(), K, everyone);
    expect(result.released.every((r) => r.cell.gender === "man")).toBe(true);
    expect(result.dropped).toBe(3);
  });
});

describe("the census against what the copy released before", () => {
  it("counts the people an earlier file released with the same value", () => {
    const prior: Released = new Map();
    remember(prior, rows(4, cell()));
    const result = census(rows(6, cell()), prior, K, everyone);
    expect(keysOf(result.released)).toEqual([cellKey(cell())]);
  });

  it("does not count people released under another value: the crossing case of ADR-029 §4", () => {
    // September: three people of the exact cell, released generalised with seven others.
    const september = census(
      [...rows(3, cell()), ...rows(7, cell({ intent: "casual" }))],
      new Map(),
      K,
      everyone,
    );
    expect(september.generalised).toBe(K);
    const prior: Released = new Map();
    remember(prior, september.released);
    // October: seven newcomers of the exact cell. The live table would hold
    // ten of them over ninety days; the copy has released none exactly.
    const october = census(rows(7, cell()), prior, K, everyone);
    expect(keysOf(october.released)).toEqual([cellKey(generalise(cell(), 1))]);
  });

  it("opens a cell for one newcomer once the copy carries it for k", () => {
    const prior: Released = new Map();
    remember(prior, census(rows(K, cell()), new Map(), K, everyone).released);
    const result = census(rows(1, cell()), prior, K, everyone);
    expect(result.released).toHaveLength(1);
    expect(result.generalised).toBe(0);
  });

  it("counts only the pseudonyms that count: one person's ten, nine of them withdrawn, open nothing", () => {
    // One person who gave, withdrew and gave again, ten times in a day: ten
    // pseudonyms in one cell, and only the last one's consent is live.
    const churned = rows(K, cell());
    const live = churned.at(-1)?.researchId;
    const result = census(churned, new Map(), K, (id) => id === live);
    expect(result).toEqual({ released: [], generalised: 0, dropped: K });
  });

  it("an earlier file's pseudonyms withdrawn since count for nobody", () => {
    const earlier = rows(K, cell());
    const prior: Released = new Map();
    remember(prior, census(earlier, new Map(), K, everyone).released);
    const newcomer = rows(1, cell());
    // All of them still in: the copy carries the cell, and the newcomer comes out as they are.
    expect(census(newcomer, prior, K, everyone).released).toHaveLength(1);
    // Nine of them gone since: two people carry it, and the newcomer is left out.
    const stayed = new Set([earlier[0]?.researchId, newcomer[0]?.researchId]);
    const result = census(newcomer, prior, K, (id) => stayed.has(id));
    expect(result).toEqual({ released: [], generalised: 0, dropped: 1 });
  });

  // What ADR-029 §4 names as still possible, the maintainer's to close (Open):
  // the cascade is a function of files the researcher holds, so a value
  // generalised while a sibling's finer cell is open says which one it hides.
  it("a value generalised past an open sibling cell gives away the finer value it hides", () => {
    const prior: Released = new Map();
    // Day 1: six of 40-49 and four of 50+, released together as 40+.
    const first = [...rows(6, cell({ ageBand: "40-49" })), ...rows(4, cell({ ageBand: "50+" }))];
    remember(prior, census(first, prior, K, everyone).released);
    // Day 2: ten of 40-49 with two intents, released as 40-49, the field withheld.
    const second = [
      ...rows(5, cell({ ageBand: "40-49" })),
      ...rows(5, cell({ ageBand: "40-49", intent: "casual" })),
    ];
    remember(prior, census(second, prior, K, everyone).released);
    // Day 3, one person alone: of 40-49 they come out as 40-49, of 50+ as 40+,
    // so 40+ now says 50+, which fewer than k carry in the copy.
    const band = (at: Cell) =>
      census(rows(1, at), prior, K, everyone).released.map((r) => r.cell.ageBand);
    expect(band(cell({ ageBand: "40-49" }))).toEqual(["40-49"]);
    expect(band(cell({ ageBand: "50+" }))).toEqual(["40+"]);
  });
});

// The properties, over small domains so that cells collide and every step is reached.
const smallCell = fc.record({
  pond: fc.constantFrom("otaniemi", "kallio", null),
  ageBand: fc.constantFrom(...AGE_BANDS),
  gender: fc.constantFrom("woman", "man", "non_binary", null),
  fields: fc.record({ intent: fc.constantFrom("long_term", "casual", null) }),
});
const day = fc.array(
  fc.record({ researchId: fc.integer({ min: 0, max: 24 }).map((i) => `p${i}`), cell: smallCell }),
  { maxLength: 60 },
);
/** Pseudonyms whose consent has ended since, out of the same small pool. */
const withdrawn = fc
  .uniqueArray(fc.integer({ min: 0, max: 24 }), { maxLength: 25 })
  .map((ns) => new Set(ns.map((n) => `p${n}`)));
const numbered = (list: { researchId: string; cell: Cell }[]): Row[] =>
  list.map((row, n) => ({ ...row, n }));

/** Distinct pseudonyms per value over a set of released rows and a prior. */
function carriers(prior: Released, released: Row[]): Map<string, Set<string>> {
  const all: Released = new Map([...prior].map(([key, ids]) => [key, new Set(ids)]));
  remember(all, released);
  return all;
}

describe("properties", () => {
  it("every released value is carried by at least k pseudonyms that count, prior and today together", () => {
    fc.assert(
      fc.property(day, day, fc.integer({ min: 1, max: 6 }), withdrawn, (before, today, k, gone) => {
        const counts = (id: string) => !gone.has(id);
        const prior: Released = new Map();
        remember(prior, before);
        const result = census(numbered(today), prior, k, counts);
        const counted = carriers(prior, result.released);
        for (const row of result.released) {
          const ids = [...(counted.get(cellKey(row.cell)) ?? [])].filter(counts);
          expect(ids.length).toBeGreaterThanOrEqual(k);
        }
      }),
      SEEDED,
    );
  });

  it("every row is released once or dropped, under its own cell or one it generalises to", () => {
    fc.assert(
      fc.property(day, fc.integer({ min: 1, max: 6 }), (today, k) => {
        const input = numbered(today);
        const result = census(input, new Map(), k, everyone);
        expect(result.released.length + result.dropped).toBe(input.length);
        expect(new Set(result.released.map((r) => r.n)).size).toBe(result.released.length);
        for (const row of result.released) {
          const own = input[row.n] as Row;
          expect(row.researchId).toBe(own.researchId);
          const levels = ([0, 1, 2, 3] as const).map((l) => cellKey(generalise(own.cell, l)));
          expect(levels).toContain(cellKey(row.cell));
        }
        const exact = result.released.filter(
          (r) => cellKey(r.cell) === cellKey(input[r.n]?.cell as Cell),
        );
        expect(result.generalised).toBe(result.released.length - exact.length);
      }),
      SEEDED,
    );
  });

  it("k holds across the whole copy, however the days follow each other", () => {
    fc.assert(
      fc.property(
        fc.array(day, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 2, max: 6 }),
        (days, k) => {
          const copy: Released = new Map();
          for (const today of days)
            remember(copy, census(numbered(today), copy, k, everyone).released);
          for (const ids of copy.values()) expect(ids.size).toBeGreaterThanOrEqual(k);
        },
      ),
      SEEDED,
    );
  });

  it("the order of the rows changes nothing", () => {
    fc.assert(
      fc.property(
        day.chain((today) =>
          fc.tuple(fc.constant(today), fc.shuffledSubarray(today, { minLength: today.length })),
        ),
        fc.integer({ min: 1, max: 6 }),
        ([today, shuffled], k) => {
          const released = (list: typeof today) =>
            census(numbered(list), new Map(), k, everyone)
              .released.map((r) => `${r.researchId} ${cellKey(r.cell)}`)
              .sort();
          expect(released(shuffled)).toEqual(released(today));
        },
      ),
      SEEDED,
    );
  });
});
