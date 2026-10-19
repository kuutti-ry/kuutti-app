import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  ROUND_ENTRIES_MAX,
  RoundDecisionUpdate,
  RoundEntryParams,
  RoundResponse,
  sinceSeenBand,
} from "./matching.ts";

// Today's round's contracts (#96, ADR-034): the bands a decision's research
// event carries, the entry addressed by its day and place, the decision, and
// the round read, at their boundaries.

const codes = (schema: z.ZodType, input: unknown) =>
  schema.safeParse(input).error?.issues.map((issue) => issue.code) ?? [];

describe("the band since a card was seen", () => {
  it.each([
    [-5_000, "under_3s"],
    [0, "under_3s"],
    [2_999, "under_3s"],
    [3_000, "3s_10s"],
    [9_999, "3s_10s"],
    [10_000, "10s_30s"],
    [29_999, "10s_30s"],
    [30_000, "30s_2m"],
    [119_999, "30s_2m"],
    [120_000, "2m_10m"],
    [599_999, "2m_10m"],
    [600_000, "10m_plus"],
    [86_400_000, "10m_plus"],
  ] as const)("reads %d ms as %s, a clock stepped back as the shortest", (ms, band) => {
    expect(sinceSeenBand(ms)).toBe(band);
  });
});

describe("an entry by its day and place", () => {
  it("takes an ISO date and a place from 1 to the round's most, a place given as text", () => {
    expect(RoundEntryParams.parse({ day: "2026-10-19", position: "3" })).toEqual({
      day: "2026-10-19",
      position: 3,
    });
    expect(
      RoundEntryParams.parse({ day: "2026-10-19", position: String(ROUND_ENTRIES_MAX) }).position,
    ).toBe(ROUND_ENTRIES_MAX);
  });

  it.each([
    ["a day that is no date", { day: "2026-02-30", position: "1" }, "invalid_format"],
    ["a word for the day", { day: "today", position: "1" }, "invalid_format"],
    ["a place of zero", { day: "2026-10-19", position: "0" }, "too_small"],
    ["a place past the most", { day: "2026-10-19", position: "51" }, "too_big"],
    ["a place in between", { day: "2026-10-19", position: "1.5" }, "invalid_type"],
  ] as const)("refuses %s", (_, input, code) => {
    expect(codes(RoundEntryParams, input)).toEqual([code]);
  });
});

describe("a decision", () => {
  it("is a like or a pass and nothing else", () => {
    expect(RoundDecisionUpdate.parse({ decision: "like" })).toEqual({ decision: "like" });
    expect(RoundDecisionUpdate.parse({ decision: "pass" })).toEqual({ decision: "pass" });
    expect(codes(RoundDecisionUpdate, { decision: "superlike" })).toEqual(["invalid_value"]);
    expect(codes(RoundDecisionUpdate, {})).toEqual(["invalid_value"]);
    expect(codes(RoundDecisionUpdate, { decision: "like", note: "x" })).toEqual([
      "unrecognized_keys",
    ]);
  });
});

describe("today's round", () => {
  it("names its day, and has no cards before it is built", () => {
    expect(RoundResponse.parse({ day: "2026-10-19", entries: null })).toEqual({
      day: "2026-10-19",
      entries: null,
    });
    expect(codes(RoundResponse, { day: "2026-10-19" })).toEqual(["invalid_type"]);
  });

  it("holds at most the round's most cards", () => {
    const tooMany = Array.from({ length: ROUND_ENTRIES_MAX + 1 }, () => ({}));
    expect(codes(RoundResponse, { day: "2026-10-19", entries: tooMany })).toContain("too_big");
  });
});
