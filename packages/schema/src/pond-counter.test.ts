import { describe, expect, it } from "vitest";
import {
  moveFigures,
  POND_COUNTER_K_MIN,
  type PondCounterCounts,
  PondCounterResponse,
  PondSeeks,
  pondCounterK,
  publishCounts,
  saidInStep,
  seeksBand,
  seeksShares,
} from "./pond-counter.ts";

// The rules of the pond counter (#54, #581, ADR-013): what may be said, and when
// what is said may move. Over any counts, in fast-check, with the API's tests:
// apps/api/src/pond/counter.test.ts.

const counts = (over: Partial<PondCounterCounts>): PondCounterCounts => ({
  finished: 0,
  seeksMen: 0,
  seeksEveryone: 0,
  seeksWomen: 0,
  ...over,
});

describe("publishCounts", () => {
  it("says no number below k, and the number itself from k up", () => {
    for (const finished of [0, 1, 9]) expect(publishCounts(counts({ finished }), 10)).toBeNull();
    for (const finished of [10, 11, 5000]) {
      expect(publishCounts(counts({ finished }), 10)).toBe(finished);
    }
    expect(publishCounts(null, 10)).toBeNull();
  });

  it("goes by the number alone, whatever the bands hold", () => {
    const bands = { seeksMen: 20, seeksEveryone: 20, seeksWomen: 20 };
    // The row a migration leaves: bands that stood, and no number yet.
    expect(publishCounts(counts({ finished: 0, ...bands }), 10)).toBeNull();
    expect(publishCounts(counts({ finished: 9, ...bands }), 10)).toBeNull();
    expect(publishCounts(counts({ finished: 10 }), 10)).toBe(10);
  });

  it("follows a k above the floor", () => {
    const pond = counts({ finished: 45 });
    expect(publishCounts(pond, 10)).toBe(45);
    expect(publishCounts(pond, 45)).toBe(45);
    expect(publishCounts(pond, 46)).toBeNull();
  });

  it("publishes nothing for a k below the floor, whatever the configuration says", () => {
    const pond = counts({ finished: 45 });
    for (const k of [9, 5, 1, 0, -1, 10.5, Number.NaN]) {
      expect(publishCounts(pond, k)).toBeNull();
    }
    expect(POND_COUNTER_K_MIN).toBe(10);
    expect(pondCounterK(1)).toBe(10);
    expect(pondCounterK(10)).toBe(10);
    expect(pondCounterK(25)).toBe(25);
    expect(pondCounterK(Number.NaN)).toBe(10);
    expect(pondCounterK(Number.POSITIVE_INFINITY)).toBe(10);
    // A fraction is rounded up, the side that says less.
    expect(pondCounterK(12.5)).toBe(13);
    expect(pondCounterK(10.1)).toBe(11);
    expect(pondCounterK(9.9)).toBe(10);
  });

  it("fails closed on a count that cannot be", () => {
    for (const finished of [-1, -20, 20.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(publishCounts(counts({ finished }), 10)).toBeNull();
    }
  });
});

describe("moveFigures", () => {
  const standing = counts({ finished: 35 });

  it("takes the first count as it is", () => {
    const today = counts({ finished: 3 });
    expect(moveFigures(null, today, 10)).toBe(today);
  });

  it("replaces figures under the floor, which were never said, every time", () => {
    const small = counts({ finished: 8 });
    const today = counts({ finished: 9 });
    expect(moveFigures(small, today, 10)).toBe(today);
    expect(moveFigures(small, today, 50)).toBe(today);
    // Nine is under the floor, and ten is not: from ten up it has been said.
    expect(moveFigures(counts({ finished: 9 }), counts({ finished: 11 }), 10)).toEqual(
      counts({ finished: 11 }),
    );
    expect(moveFigures(counts({ finished: 10 }), counts({ finished: 11 }), 10)).toEqual(
      counts({ finished: 10 }),
    );
  });

  it("replaces the row a migration left at once, its number at zero and its bands standing (#581)", () => {
    const left = counts({ finished: 0, seeksMen: 20, seeksEveryone: 10, seeksWomen: 20 });
    const today = counts({ finished: 52, seeksMen: 21, seeksEveryone: 10, seeksWomen: 20 });
    expect(moveFigures(left, today, 10)).toBe(today);
  });

  it("keeps figures that were said under k = 10 standing while k is raised, and says them again unchanged", () => {
    const said = counts({ finished: 45 });
    const before = publishCounts(said, 10);
    // k is raised to 50: nothing is said of the pond, and one person finishes.
    const joined = counts({ finished: 46 });
    const held = moveFigures(said, joined, 50);
    expect(held).toBe(said);
    expect(publishCounts(held, 50)).toBeNull();
    // k returns to 10: what is said is what was said, not the pond a person later.
    expect(publishCounts(moveFigures(held, joined, 10), 10)).toBe(before);
  });

  it("never steps by less than the floor, whatever k it is given", () => {
    const next = counts({ finished: 36 });
    for (const k of [1, 0, -5, 9]) expect(moveFigures(standing, next, k)).toBe(standing);
  });

  it("stands still while fewer than k people have come or gone", () => {
    for (const finished of [26, 34, 36, 44]) {
      expect(moveFigures(standing, counts({ finished }), 10)).toBe(standing);
    }
  });

  it("moves once the number has moved by k, up or down", () => {
    const grown = counts({ finished: 45 });
    expect(moveFigures(standing, grown, 10)).toEqual(grown);
    const shrunk = counts({ finished: 25 });
    expect(moveFigures(standing, shrunk, 10)).toEqual(shrunk);
  });

  it("never shows one arrival: a day's difference of one changes nothing that is published", () => {
    const before = publishCounts(moveFigures(null, standing, 10), 10);
    const after = publishCounts(moveFigures(standing, counts({ finished: 36 }), 10), 10);
    expect(after).toBe(before);
  });

  it("does not show the number falling under k by one departure", () => {
    const atTheFloor = counts({ finished: 10 });
    expect(publishCounts(moveFigures(atTheFloor, counts({ finished: 9 }), 10), 10)).toBe(10);
  });

  it("never says two states a day and one person apart", () => {
    const night1 = counts({ finished: 50 });
    const night2 = counts({ finished: 59 });
    const night3 = counts({ finished: 60 });
    const said1 = moveFigures(null, night1, 10);
    const said2 = moveFigures(said1, night2, 10);
    const said3 = moveFigures(said2, night3, 10);
    expect(said2).toBe(night1);
    expect(said3).toEqual(night3);
    expect(said3.finished - said2.finished).toBeGreaterThanOrEqual(10);
  });

  it("returns the standing figures themselves when the count is the same", () => {
    expect(moveFigures(standing, { ...standing }, 10)).toBe(standing);
    // Under the floor too, or the job would write a row that has not moved.
    const small = counts({ finished: 3 });
    expect(moveFigures(small, { ...small }, 10)).toBe(small);
  });

  describe("the bands of the bar (#507)", () => {
    const bands = { seeksMen: 20, seeksEveryone: 10, seeksWomen: 20 };
    const said = counts({ finished: 50, ...bands });

    it("keeps the bands when the number moves by k and they move by less", () => {
      // Ten finished, nine of them in no band: one more band figure would say what one person seeks.
      const today = counts({ ...said, finished: 60, seeksWomen: 21 });
      expect(moveFigures(said, today, 10)).toEqual({ ...today, ...bands });
    });

    it("moves the bands alone once they have moved by k, the number standing", () => {
      // Five finished and five who stood in no band chose: the number has moved by less than k.
      const today = counts({ finished: 55, seeksMen: 25, seeksEveryone: 10, seeksWomen: 25 });
      expect(moveFigures(said, today, 10)).toEqual({
        finished: 50,
        seeksMen: 25,
        seeksEveryone: 10,
        seeksWomen: 25,
      });
    });

    it("moves bands and number together when both have moved by k", () => {
      const today = counts({ ...said, finished: 60, seeksMen: 30 });
      expect(moveFigures(said, today, 10)).toEqual(today);
    });

    it("moves once k people have changed band, and stands while fewer have", () => {
      const nine = counts({ ...said, seeksMen: 11, seeksWomen: 29 });
      expect(moveFigures(said, nine, 10)).toBe(said);
      const ten = counts({ ...said, seeksMen: 10, seeksWomen: 30 });
      expect(moveFigures(said, ten, 10)).toEqual({ ...said, seeksMen: 10, seeksWomen: 30 });
    });

    it("goes by the larger side of a mixed move, which is how few people it can be", () => {
      const today = counts({ ...said, seeksMen: 26, seeksEveryone: 7, seeksWomen: 17 });
      expect(moveFigures(said, today, 10)).toBe(said); // 6 rose, 6 fell
      const further = counts({ ...said, seeksMen: 30, seeksEveryone: 7, seeksWomen: 17 });
      expect(moveFigures(said, further, 10).seeksMen).toBe(30); // 10 rose, 6 fell
    });

    it("counts a shrinking sum as a move, and follows a raised k", () => {
      const shrunk = counts({ ...said, seeksMen: 10 });
      expect(moveFigures(said, shrunk, 10).seeksMen).toBe(10);
      expect(moveFigures(said, shrunk, 11)).toBe(said);
    });

    it.each(["seeksMen", "seeksEveryone", "seeksWomen"] as const)(
      "sees %s move by k with nothing else moving",
      (band) => {
        const today = counts({ ...said, [band]: said[band] + 10 });
        expect(moveFigures(said, today, 10)).toEqual(today);
      },
    );

    it("takes the bands of a row from before them at the first count they have moved by k", () => {
      const before = counts({ finished: 50 });
      const today = counts({ finished: 50, ...bands });
      expect(moveFigures(before, today, 10)).toEqual(today);
    });
  });
});

describe("seeksBand", () => {
  it("goes by women and men alone: non-binary in the set moves no band", () => {
    expect(seeksBand(["man"])).toBe("seeksMen");
    expect(seeksBand(["man", "non_binary"])).toBe("seeksMen");
    expect(seeksBand(["woman"])).toBe("seeksWomen");
    expect(seeksBand(["woman", "non_binary"])).toBe("seeksWomen");
    expect(seeksBand(["woman", "man"])).toBe("seeksEveryone");
    expect(seeksBand(["man", "woman", "non_binary"])).toBe("seeksEveryone");
  });

  it("gives no band to somebody who seeks neither, or nobody yet", () => {
    expect(seeksBand(["non_binary"])).toBeNull();
    expect(seeksBand([])).toBeNull();
    expect(seeksBand(null)).toBeNull();
  });
});

describe("seeksShares", () => {
  const bands = (seeksMen: number, seeksEveryone: number, seeksWomen: number) => ({
    seeksMen,
    seeksEveryone,
    seeksWomen,
  });

  it("says shares of the three together, in steps of five", () => {
    expect(seeksShares(bands(30, 20, 50), 10)).toEqual({ men: 30, everyone: 20, women: 50 });
    expect(seeksShares(bands(47, 21, 32), 10)).toEqual({ men: 50, everyone: 20, women: 30 });
    expect(seeksShares(bands(12, 10, 10), 10)).toEqual({ men: 40, everyone: 30, women: 30 });
  });

  it("adds up to 100, the largest band taking what the others leave", () => {
    expect(seeksShares(bands(10, 10, 10), 10)).toEqual({ men: 35, everyone: 30, women: 35 });
    expect(seeksShares(bands(12, 11, 10), 10)).toEqual({ men: 35, everyone: 35, women: 30 });
    expect(seeksShares(bands(10, 12, 11), 10)).toEqual({ men: 30, everyone: 35, women: 35 });
    expect(seeksShares(bands(10, 11, 12), 10)).toEqual({ men: 30, everyone: 35, women: 35 });
    for (let men = 10; men < 90; men += 7) {
      for (let everyone = 10; everyone < 90; everyone += 7) {
        for (let women = 10; women < 90; women += 7) {
          const shares = seeksShares(bands(men, everyone, women), 10);
          expect(PondSeeks.safeParse(shares).success).toBe(true);
          expect((shares?.men ?? 0) + (shares?.everyone ?? 0) + (shares?.women ?? 0)).toBe(100);
        }
      }
    }
  });

  it("does not turn back into counts near k", () => {
    // Whole percents told these two apart: 38, 31, 31 could only be 12, 10 and 10.
    expect(seeksShares(bands(12, 10, 10), 10)).toEqual(seeksShares(bands(13, 11, 10), 10));
  });

  it("says nothing unless every band is at least k", () => {
    expect(seeksShares(bands(30, 9, 50), 10)).toBeNull();
    expect(seeksShares(bands(9, 30, 50), 10)).toBeNull();
    expect(seeksShares(bands(30, 50, 9), 10)).toBeNull();
    expect(seeksShares(bands(30, 0, 50), 10)).toBeNull();
    expect(seeksShares(bands(0, 0, 0), 10)).toBeNull();
    expect(seeksShares(null, 10)).toBeNull();
  });

  it("follows a k above the floor", () => {
    expect(seeksShares(bands(20, 20, 20), 20)).not.toBeNull();
    expect(seeksShares(bands(20, 19, 20), 20)).toBeNull();
  });

  it("says nothing for a k below the floor, whatever the configuration says", () => {
    for (const k of [9, 5, 1, 0, -1, 10.5, Number.NaN]) {
      expect(seeksShares(bands(30, 20, 50), k)).toBeNull();
    }
  });

  it("never says 0 % of a band that holds at least k people", () => {
    const shares = seeksShares(bands(10, 10, 5000), 10);
    expect(shares).toEqual({ men: 5, everyone: 5, women: 90 });
    expect(PondSeeks.safeParse(shares).success).toBe(true);
  });

  it("fails closed on bands that cannot be", () => {
    expect(seeksShares(bands(-30, 20, 50), 10)).toBeNull();
    expect(seeksShares(bands(30.5, 20, 50), 10)).toBeNull();
    expect(seeksShares(bands(Number.NaN, 20, 50), 10)).toBeNull();
  });
});

describe("the bar", () => {
  const valid = { men: 30, everyone: 20, women: 50 };

  it("carries three shares and nothing else", () => {
    expect(PondSeeks.parse(valid)).toEqual(valid);
    expect(PondSeeks.safeParse({ men: 30, everyone: 70 }).success).toBe(false);
    expect(PondSeeks.safeParse({ ...valid, count: 12 }).success).toBe(false);
  });

  it("cannot carry a share that is none, more than the whole, or off the step", () => {
    for (const men of [0, -1, 105, 30.5, 31, 1]) {
      expect(PondSeeks.safeParse({ ...valid, men }).success).toBe(false);
    }
  });
});

describe("the response", () => {
  const pond = {
    id: "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01",
    slug: "suomi",
    name: "Suomi",
  };
  const hidden = { pond, day: null, finished: null, seeks: null };
  const accepts = (entry: unknown) =>
    PondCounterResponse.safeParse({ k: 10, ponds: [entry] }).success;

  it("carries a day, never a time, and no id but the pond's", () => {
    const parsed = PondCounterResponse.parse({
      k: 10,
      ponds: [hidden, { ...hidden, day: "2026-09-27", finished: 25 }],
    });
    expect(parsed.ponds).toHaveLength(2);
    expect(accepts({ ...hidden, day: "2026-09-27T04:00:00Z" })).toBe(false);
    expect(PondCounterResponse.safeParse({ ...parsed, takenAt: "x" }).success).toBe(false);
  });

  it("has a place for the bar on every pond, shares or null", () => {
    const seeks = { men: 30, everyone: 20, women: 50 };
    expect(accepts({ ...hidden, seeks })).toBe(true);
    expect(accepts({ ...hidden, seeks: null })).toBe(true);
    const { seeks: _left, ...without } = hidden;
    expect(accepts(without)).toBe(false);
    expect(accepts({ ...hidden, seeks: { ...seeks, men: 31 } })).toBe(false);
    expect(accepts({ ...hidden, seeks: { ...seeks, count: 12 } })).toBe(false);
  });

  it("cannot carry a number under the floor, or a k under it", () => {
    expect(PondCounterResponse.safeParse({ k: 9, ponds: [] }).success).toBe(false);
    expect(PondCounterResponse.safeParse({ k: 10, ponds: [] }).success).toBe(true);
    for (const finished of [null, 10, 11, 5000]) {
      expect(accepts({ ...hidden, finished })).toBe(true);
    }
    for (const finished of [9, 1, 0, -1, 10.5, "10"]) {
      expect(accepts({ ...hidden, finished })).toBe(false);
    }
  });

  it("asks every pond for its number, even when it is null", () => {
    const { finished: _left, ...without } = hidden;
    expect(accepts(without)).toBe(false);
  });

  it("has no place for a total, a gender split or the number finishing (#581)", () => {
    const split = { woman: 13, man: 12, nonBinary: 10 };
    for (const old of [
      { verified: 35 },
      { verified: null },
      { split },
      { split: null },
      { finishing: 0 },
      { finishing: null },
      split,
    ]) {
      expect(accepts({ ...hidden, ...old })).toBe(false);
    }
  });
});

describe("a count about one person's pool", () => {
  it.each([
    [0, 10, 0],
    [9, 10, 0],
    [10, 10, 10],
    [19, 10, 10],
    [20, 10, 20],
    [55, 20, 40],
  ])("%i in steps of %i is said as %i, rounded down", (count, step, said) => {
    expect(saidInStep(count, step)).toBe(said);
  });
});
