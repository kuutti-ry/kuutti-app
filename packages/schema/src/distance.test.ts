import { describe, expect, it } from "vitest";
import {
  DISTANCE_BANDS,
  DISTANCE_FILTER_BANDS,
  DistanceBand,
  type DistanceEdges,
  distanceBand,
} from "./distance.ts";

// The bands of ADR-061 §5: nearby under the first edge, close under the second,
// around under the third, far beyond, each edge itself in the next band out;
// total over every number and over edges in any order, since the panel holds
// an edge to being a number and no more.

const edges: DistanceEdges = { nearby: 5, close: 15, around: 50 };

describe("a distance band", () => {
  it("is one of four, nearest first", () => {
    expect(DISTANCE_BANDS).toEqual(["nearby", "close", "around", "far"]);
    expect(DistanceBand.options).toEqual([...DISTANCE_BANDS]);
    expect(DistanceBand.safeParse("12 km").success).toBe(false);
  });

  it("is what a filter may accept, but for far, which filters nobody", () => {
    expect(DISTANCE_FILTER_BANDS).toEqual(["nearby", "close", "around"]);
  });
});

describe("a distance in kilometres", () => {
  it.each([
    [0, "nearby"],
    [0.5, "nearby"],
    [4.999, "nearby"],
    [5, "close"],
    [5.001, "close"],
    [14.999, "close"],
    [15, "around"],
    [15.001, "around"],
    [49.999, "around"],
    [50, "far"],
    [50.001, "far"],
    [1_200, "far"],
  ] as const)("reads %d km as %s", (km, band) => {
    expect(distanceBand(km, edges)).toBe(band);
  });

  it("reads what no two homes can be and never fails", () => {
    expect(distanceBand(-1, edges)).toBe("nearby");
    expect(distanceBand(Number.POSITIVE_INFINITY, edges)).toBe("far");
    expect(distanceBand(Number.NaN, edges)).toBe("far");
  });
});

describe("edges in any order", () => {
  it.each([
    ["the first past the second", { nearby: 20, close: 15, around: 50 }, 18, "nearby"],
    ["the first past the second, beyond it", { nearby: 20, close: 15, around: 50 }, 30, "around"],
    ["the second past the third", { nearby: 5, close: 60, around: 50 }, 55, "close"],
    ["the third under them all", { nearby: 5, close: 15, around: 1 }, 20, "far"],
    ["reversed, inside the first", { nearby: 50, close: 15, around: 5 }, 49, "nearby"],
    ["reversed, past them all", { nearby: 50, close: 15, around: 5 }, 50, "far"],
    ["all the same, under them", { nearby: 5, close: 5, around: 5 }, 4, "nearby"],
    ["all the same, at them", { nearby: 5, close: 5, around: 5 }, 5, "far"],
    ["all zero", { nearby: 0, close: 0, around: 0 }, 0, "far"],
    ["below zero", { nearby: -5, close: -1, around: -9 }, 0, "far"],
  ] as const)("read %s", (_, unordered, km, band) => {
    expect(distanceBand(km, unordered)).toBe(band);
  });

  it("never read a longer distance as a nearer band", () => {
    const values = [0, 5, 15, 50];
    for (const nearby of values) {
      for (const close of values) {
        for (const around of values) {
          const unordered = { nearby, close, around };
          let last = 0;
          for (let km = 0; km <= 60; km += 0.5) {
            const band = DISTANCE_BANDS.indexOf(distanceBand(km, unordered));
            expect(band, JSON.stringify({ ...unordered, km })).toBeGreaterThanOrEqual(last);
            last = band;
          }
        }
      }
    }
  });
});
