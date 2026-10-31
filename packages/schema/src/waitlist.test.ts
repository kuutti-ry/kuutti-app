import { describe, expect, it } from "vitest";
import {
  moveFigures,
  PondSeeksResponse,
  publishCounts,
  saidInStep,
  seeksBand,
  seeksShares,
  WAITLIST_K_MIN,
  type WaitlistCounts,
  WaitlistResponse,
  waitlistK,
} from "./waitlist.ts";

// The rules of the waitlist counter (#54, ADR-013): what may be said, and when
// what is said may move.

const counts = (over: Partial<WaitlistCounts>): WaitlistCounts => ({
  verified: 0,
  woman: 0,
  man: 0,
  nonBinary: 0,
  finishing: 0,
  seeksMen: 0,
  seeksEveryone: 0,
  seeksWomen: 0,
  ...over,
});

const NOTHING = { verified: null, split: null, finishing: null };

describe("publishCounts", () => {
  it("says nothing about a pond below k, not even a part of it", () => {
    for (const verified of [0, 1, 9]) {
      expect(publishCounts(counts({ verified, woman: verified, finishing: verified }), 10)).toEqual(
        NOTHING,
      );
    }
    expect(publishCounts(null, 10)).toEqual(NOTHING);
  });

  it("publishes the split when every cell is at least k", () => {
    expect(
      publishCounts(counts({ verified: 75, woman: 40, man: 25, nonBinary: 10, finishing: 12 }), 10),
    ).toEqual({ verified: 75, split: { woman: 40, man: 25, nonBinary: 10 }, finishing: 12 });
  });

  it("hides the whole split for one small cell, because the third would be a subtraction", () => {
    const published = publishCounts(
      counts({ verified: 78, woman: 40, man: 35, nonBinary: 3, finishing: 12 }),
      10,
    );
    expect(published).toEqual({ verified: 78, split: null, finishing: 12 });
    // Nothing in what is published lets 3 be computed.
    expect(JSON.stringify(published)).not.toContain("35");
  });

  it("hides the split of a pond where a cell is empty: a zero says what nobody there declared", () => {
    // Everyone here declared the same: the split would say it of each of them.
    expect(publishCounts(counts({ verified: 12, woman: 12 }), 10).split).toBeNull();
    // Nobody here declared non-binary: the split would say that of each of them.
    expect(publishCounts(counts({ verified: 25, woman: 13, man: 12 }), 10).split).toBeNull();
  });

  it("hides the split when the people without a declared gender are a small remainder", () => {
    const cells = { woman: 12, man: 11, nonBinary: 10 };
    expect(publishCounts(counts({ verified: 33, ...cells }), 10).split).toEqual(cells);
    expect(publishCounts(counts({ verified: 40, ...cells }), 10).split).toBeNull(); // 7 undeclared
    expect(publishCounts(counts({ verified: 43, ...cells }), 10).split).toEqual(cells);
  });

  it("says how many are finishing only when they and the rest are none or at least k", () => {
    const finishing = (verified: number, n: number) =>
      publishCounts(counts({ verified, finishing: n }), 10).finishing;
    expect(finishing(25, 15)).toBe(15);
    expect(finishing(25, 0)).toBe(0);
    expect(finishing(25, 25)).toBe(25);
    expect(finishing(25, 1)).toBeNull();
    expect(finishing(25, 24)).toBeNull(); // one complete profile
    expect(finishing(12, 9)).toBeNull();
    // The total stands whatever happens to the part.
    expect(publishCounts(counts({ verified: 12, finishing: 9 }), 10).verified).toBe(12);
  });

  it("follows a k above the floor", () => {
    const pond = counts({ verified: 45, woman: 15, man: 15, nonBinary: 15 });
    expect(publishCounts(pond, 10).split).not.toBeNull();
    expect(publishCounts(pond, 20)).toEqual({ verified: 45, split: null, finishing: 0 });
    expect(publishCounts(pond, 50)).toEqual(NOTHING);
  });

  it("publishes nothing for a k below the floor, whatever the configuration says", () => {
    const pond = counts({ verified: 45, woman: 15, man: 15, nonBinary: 15 });
    for (const k of [9, 5, 1, 0, -1, 10.5, Number.NaN]) {
      expect(publishCounts(pond, k)).toEqual(NOTHING);
    }
    expect(WAITLIST_K_MIN).toBe(10);
    expect(waitlistK(1)).toBe(10);
    expect(waitlistK(10)).toBe(10);
    expect(waitlistK(25)).toBe(25);
    expect(waitlistK(Number.NaN)).toBe(10);
    expect(waitlistK(Number.POSITIVE_INFINITY)).toBe(10);
    // A fraction is rounded up, the side that says less.
    expect(waitlistK(12.5)).toBe(13);
    expect(waitlistK(10.1)).toBe(11);
    expect(waitlistK(9.9)).toBe(10);
  });

  it("fails closed on counts that cannot be", () => {
    expect(publishCounts(counts({ verified: 20, finishing: 21 }), 10)).toEqual(NOTHING);
    expect(publishCounts(counts({ verified: 20, woman: 15, man: 15 }), 10)).toEqual(NOTHING);
    expect(publishCounts(counts({ verified: 20, woman: -1 }), 10)).toEqual(NOTHING);
    expect(publishCounts(counts({ verified: 20.5 }), 10)).toEqual(NOTHING);
  });
});

describe("moveFigures", () => {
  const standing = counts({ verified: 35, woman: 13, man: 12, nonBinary: 10, finishing: 20 });

  it("takes the first count as it is", () => {
    const today = counts({ verified: 3, woman: 3 });
    expect(moveFigures(null, today, 10)).toBe(today);
  });

  it("replaces figures under the floor, which were never said, every time", () => {
    const small = counts({ verified: 8, woman: 8 });
    const today = counts({ verified: 9, woman: 9 });
    expect(moveFigures(small, today, 10)).toBe(today);
    expect(moveFigures(small, today, 50)).toBe(today);
  });

  it("keeps figures that were said under k = 10 standing while k is raised, and says them again unchanged", () => {
    const said = counts({ verified: 45, woman: 15, man: 15, nonBinary: 15 });
    const before = publishCounts(said, 10);
    // k is raised to 50: nothing is said of the pond, and one woman joins.
    const joined = counts({ ...said, verified: 46, woman: 16 });
    const held = moveFigures(said, joined, 50);
    expect(held).toBe(said);
    expect(publishCounts(held, 50)).toEqual(NOTHING);
    // k returns to 10: what is said is what was said, not the pond a person later.
    expect(publishCounts(moveFigures(held, joined, 10), 10)).toEqual(before);
  });

  it("never steps by less than the floor, whatever k it is given", () => {
    const next = counts({ ...standing, verified: 36, woman: 14 });
    for (const k of [1, 0, -5, 9]) expect(moveFigures(standing, next, k)).toBe(standing);
  });

  it("stands still while fewer than k people have come or gone", () => {
    for (const verified of [26, 34, 36, 44]) {
      const today = counts({ ...standing, verified, woman: standing.woman + verified - 35 });
      expect(moveFigures(standing, today, 10)).toBe(standing);
    }
  });

  it("moves, total and cells together, once the total has moved by k", () => {
    const grown = counts({ verified: 45, woman: 22, man: 13, nonBinary: 10, finishing: 21 });
    expect(moveFigures(standing, grown, 10)).toEqual(grown);
    const shrunk = counts({ verified: 25, woman: 8, man: 9, nonBinary: 8, finishing: 12 });
    expect(moveFigures(standing, shrunk, 10)).toEqual(shrunk);
  });

  it("never shows one arrival: a day's difference of one changes nothing that is published", () => {
    const next = counts({ ...standing, verified: 36, woman: 14 });
    const before = publishCounts(moveFigures(null, standing, 10), 10);
    const after = publishCounts(moveFigures(standing, next, 10), 10);
    expect(after).toEqual(before);
  });

  it("does not show a cell falling under k by one departure", () => {
    const next = counts({ ...standing, verified: 34, nonBinary: 9 });
    expect(publishCounts(moveFigures(standing, next, 10), 10).split).toEqual({
      woman: 13,
      man: 12,
      nonBinary: 10,
    });
  });

  it("moves the people finishing only with the total, however far they have moved", () => {
    const today = counts({ ...standing, verified: 37, woman: 15, finishing: 8 });
    expect(moveFigures(standing, today, 10)).toBe(standing);
  });

  it("never says two states a day and one person apart", () => {
    // Thirty people finish their profiles while nine join, then one more joins.
    const night1 = counts({ verified: 50, woman: 20, man: 20, nonBinary: 10, finishing: 50 });
    const night2 = counts({ ...night1, verified: 59, woman: 29, finishing: 30 });
    const night3 = counts({ ...night2, verified: 60, woman: 30, finishing: 31 });
    const said1 = moveFigures(null, night1, 10);
    const said2 = moveFigures(said1, night2, 10);
    const said3 = moveFigures(said2, night3, 10);
    expect(said2).toBe(night1);
    expect(said3).toEqual(night3);
    expect(said3.verified - said2.verified).toBeGreaterThanOrEqual(10);
  });

  it("returns the standing figures themselves when the count is the same", () => {
    expect(moveFigures(standing, { ...standing }, 10)).toBe(standing);
  });

  describe("the bands of the bar (#507)", () => {
    const bands = { seeksMen: 20, seeksEveryone: 10, seeksWomen: 20 };
    const said = counts({ ...standing, ...bands });

    it("keeps the bands when the total moves by k and they move by less", () => {
      // Ten came, nine of them unfinished: one more band figure would say what one person seeks.
      const today = counts({ ...said, verified: 45, finishing: 29, seeksWomen: 21 });
      expect(moveFigures(said, today, 10)).toEqual({ ...today, ...bands });
    });

    it("moves the bands alone once they have moved by k, the total standing", () => {
      // Ten finished their profiles and nobody came.
      const today = counts({ ...said, finishing: 10, seeksMen: 25, seeksWomen: 25 });
      expect(moveFigures(said, today, 10)).toEqual({
        ...said,
        seeksMen: 25,
        seeksEveryone: 10,
        seeksWomen: 25,
      });
    });

    it("moves bands and total together when both have moved by k", () => {
      const today = counts({ ...said, verified: 45, seeksMen: 30 });
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

    it("takes the bands of a row from before them at the first count they have moved by k", () => {
      const before = counts({ ...standing });
      expect(moveFigures(before, counts({ ...standing, ...bands }), 10)).toEqual({
        ...standing,
        ...bands,
      });
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
          expect(PondSeeksResponse.safeParse({ seeks: shares }).success).toBe(true);
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
    expect(PondSeeksResponse.safeParse({ seeks: shares }).success).toBe(true);
  });

  it("fails closed on bands that cannot be", () => {
    expect(seeksShares(bands(-30, 20, 50), 10)).toBeNull();
    expect(seeksShares(bands(30.5, 20, 50), 10)).toBeNull();
    expect(seeksShares(bands(Number.NaN, 20, 50), 10)).toBeNull();
  });
});

describe("the bar's answer", () => {
  const valid = { men: 30, everyone: 20, women: 50 };

  it("carries three shares or null, and nothing else", () => {
    expect(PondSeeksResponse.parse({ seeks: valid })).toEqual({ seeks: valid });
    expect(PondSeeksResponse.parse({ seeks: null })).toEqual({ seeks: null });
    expect(PondSeeksResponse.safeParse({}).success).toBe(false);
    expect(PondSeeksResponse.safeParse({ seeks: null, k: 10 }).success).toBe(false);
    expect(PondSeeksResponse.safeParse({ seeks: { ...valid, count: 12 } }).success).toBe(false);
  });

  it("cannot carry a share that is none, more than the whole, or off the step", () => {
    for (const men of [0, -1, 105, 30.5, 31, 1]) {
      expect(PondSeeksResponse.safeParse({ seeks: { ...valid, men } }).success).toBe(false);
    }
  });
});

describe("the response", () => {
  const pond = {
    id: "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01",
    slug: "otaniemi",
    name: "Otaniemi",
    nameInessive: "Otaniemessä",
    parentId: null,
  };
  const hidden = { pond, day: null, verified: null, split: null, finishing: null };

  it("carries a day, never a time, and no id but the pond's", () => {
    const parsed = WaitlistResponse.parse({
      k: 10,
      ponds: [hidden, { ...hidden, day: "2026-09-27", verified: 25, finishing: 0 }],
    });
    expect(parsed.ponds).toHaveLength(2);
    expect(
      WaitlistResponse.safeParse({ k: 10, ponds: [{ ...hidden, day: "2026-09-27T04:00:00Z" }] })
        .success,
    ).toBe(false);
    expect(WaitlistResponse.safeParse({ ...parsed, takenAt: "x" }).success).toBe(false);
  });

  it("cannot carry a number under the floor, or a k under it", () => {
    expect(WaitlistResponse.safeParse({ k: 9, ponds: [] }).success).toBe(false);
    expect(WaitlistResponse.safeParse({ k: 10, ponds: [{ ...hidden, verified: 9 }] }).success).toBe(
      false,
    );
    expect(
      WaitlistResponse.safeParse({
        k: 10,
        ponds: [{ ...hidden, verified: 25, split: { woman: 13, man: 12, nonBinary: 0 } }],
      }).success,
    ).toBe(false);
    const finishing = (n: number) =>
      WaitlistResponse.safeParse({ k: 10, ponds: [{ ...hidden, verified: 25, finishing: n }] })
        .success;
    expect(finishing(0)).toBe(true);
    expect(finishing(10)).toBe(true);
    for (const n of [1, 9, -1, 10.5]) expect(finishing(n)).toBe(false);
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
