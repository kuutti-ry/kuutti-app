import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { DEAL_BREAKERS_CAP } from "./deal-breakers.ts";
import {
  ExportedRoundEntry,
  QUEUE_PAGE,
  Relaxation,
  RelaxationAnswer,
  RelaxationKind,
  RelaxationOffer,
  RelaxationParams,
  RelaxationsResponse,
  RelaxationUndone,
  ROUND_POSITION_MAX,
  RoundChoice,
  RoundDayParams,
  RoundDecision,
  RoundDecisionAnswer,
  RoundDecisionUpdate,
  RoundEntry,
  RoundEntryParams,
  RoundResponse,
  sinceSeenBand,
} from "./matching.ts";

// The queue's contracts and its day's log (#96, #502, ADR-034, ADR-062): the
// bands a decision's research event carries, the entry addressed by its day and
// place, the decision, and the read of the next cards, at their boundaries.

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

describe("an entry's distance", () => {
  const distance = RoundEntry.shape.distance;

  it.each(["nearby", "close", "around", "far"])("is the band %s", (band) => {
    expect(distance.parse(band)).toBe(band);
  });

  it("is null on an entry from before it, and must be said", () => {
    expect(distance.parse(null)).toBeNull();
    expect(codes(distance, undefined)).toEqual(["invalid_value"]);
  });

  it("is never kilometres", () => {
    expect(codes(distance, 12)).toEqual(["invalid_value"]);
    expect(codes(distance, "12 km")).toEqual(["invalid_value"]);
  });
});

describe("an entry by its day and place", () => {
  it("takes an ISO date and a place from 1 to the column's range, a place given as text", () => {
    expect(RoundEntryParams.parse({ day: "2026-10-19", position: "3" })).toEqual({
      day: "2026-10-19",
      position: 3,
    });
    expect(
      RoundEntryParams.parse({ day: "2026-10-19", position: String(ROUND_POSITION_MAX) }).position,
    ).toBe(ROUND_POSITION_MAX);
  });

  it.each([
    ["a day that is no date", { day: "2026-02-30", position: "1" }, "invalid_format"],
    ["a word for the day", { day: "today", position: "1" }, "invalid_format"],
    ["a place of zero", { day: "2026-10-19", position: "0" }, "too_small"],
    [
      "a place past the most",
      { day: "2026-10-19", position: String(ROUND_POSITION_MAX + 1) },
      "too_big",
    ],
    ["a place in between", { day: "2026-10-19", position: "1.5" }, "invalid_type"],
  ] as const)("refuses %s", (_, input, code) => {
    expect(codes(RoundEntryParams, input)).toEqual([code]);
  });
});

describe("a decision", () => {
  it("is a like, a pass, a fish or a skip and nothing else (ADR-062 §3)", () => {
    for (const decision of ["like", "pass", "fish", "skip"] as const) {
      expect(RoundDecisionUpdate.parse({ decision })).toEqual({ decision });
    }
    expect(codes(RoundDecisionUpdate, { decision: "superlike" })).toEqual(["invalid_value"]);
    expect(codes(RoundDecisionUpdate, {})).toEqual(["invalid_value"]);
    expect(codes(RoundDecisionUpdate, { decision: "like", note: "x" })).toEqual([
      "unrecognized_keys",
    ]);
  });
});

describe("the answer to a decision", () => {
  it("names a match or none, and says whether a fish can still go (#475) and whose turn waits (ADR-062 §5)", () => {
    const match = { conversationId: "7d8f3c2a-1b4e-4c6d-9e0f-2a3b4c5d6e7f" };
    const made = { match, fishToSend: false, likesLeft: 0, yourTurn: 8 };
    expect(RoundDecisionAnswer.parse(made)).toEqual(made);
    const none = { match: null, fishToSend: true, likesLeft: 7, yourTurn: 0 };
    expect(RoundDecisionAnswer.parse(none)).toEqual(none);
  });

  const answer = { match: null, fishToSend: true, likesLeft: 7, yourTurn: 0 };

  it.each([
    ["no word on the fish", { ...answer, fishToSend: undefined }, "invalid_type"],
    ["the fish as a count", { ...answer, fishToSend: 1 }, "invalid_type"],
    ["no word on the likes", { ...answer, likesLeft: undefined }, "invalid_type"],
    ["the likes below zero", { ...answer, likesLeft: -1 }, "too_small"],
    ["the likes in part", { ...answer, likesLeft: 1.5 }, "invalid_type"],
    ["no word on the turn", { ...answer, yourTurn: undefined }, "invalid_type"],
    ["the turn below zero", { ...answer, yourTurn: -1 }, "too_small"],
    ["the turn in part", { ...answer, yourTurn: 1.5 }, "invalid_type"],
    ["the turn as a flag", { ...answer, yourTurn: true }, "invalid_type"],
    ["anything else", { ...answer, liked: true }, "unrecognized_keys"],
  ] as const)("refuses %s", (_, input, code) => {
    expect(codes(RoundDecisionAnswer, input)).toEqual([code]);
  });
});

describe("the next cards of the queue", () => {
  const round = {
    day: "2026-10-19",
    entries: null,
    fishToSend: true,
    likesLeft: 10,
    yourTurn: 0,
  };

  it("names its day, null before matching opens and an empty list at the queue's end (ADR-062 §1)", () => {
    expect(RoundResponse.parse(round)).toEqual(round);
    expect(RoundResponse.parse({ ...round, entries: [] }).entries).toEqual([]);
    expect(codes(RoundResponse, { ...round, entries: undefined })).toEqual(["invalid_type"]);
  });

  it("says whether a fish can go today, never how many (#475)", () => {
    expect(codes(RoundResponse, { ...round, fishToSend: undefined })).toEqual(["invalid_type"]);
    expect(codes(RoundResponse, { ...round, fishToSend: 0 })).toEqual(["invalid_type"]);
  });

  it.each([
    ["no word on them", undefined, "invalid_type"],
    ["below zero", -1, "too_small"],
    ["in part", 1.5, "invalid_type"],
    ["as a flag", true, "invalid_type"],
  ] as const)(
    "refuses the conversations on the caller's turn %s (ADR-062 §5)",
    (_, yourTurn, code) => {
      expect(codes(RoundResponse, { ...round, yourTurn })).toEqual([code]);
    },
  );

  it.each([
    ["no word on them", undefined, "invalid_type"],
    ["below zero", -1, "too_small"],
    ["in part", 1.5, "invalid_type"],
    ["in words", "ten", "invalid_type"],
  ] as const)("refuses the likes left %s (#524)", (_, likesLeft, code) => {
    expect(codes(RoundResponse, { ...round, likesLeft })).toEqual([code]);
  });

  it("hands over a page at most, and a page is ten (ADR-062 §15)", () => {
    expect(QUEUE_PAGE).toBe(10);
    const tooMany = Array.from({ length: QUEUE_PAGE + 1 }, () => ({}));
    expect(codes(RoundResponse, { ...round, entries: tooMany })).toContain("too_big");
  });
});

describe("what a person does with a card", () => {
  it("is a like, a pass or a skip as stored, and a fish as chosen (ADR-062 §3)", () => {
    expect(RoundDecision.options).toEqual(["like", "pass", "skip"]);
    expect(RoundChoice.options).toEqual(["like", "pass", "fish", "skip"]);
  });
});

describe("relaxing a deal-breaker for the day (#99, ADR-042)", () => {
  it("has two ways, closed", () => {
    expect(RelaxationKind.options).toEqual(["unanswered", "aside"]);
  });

  it("takes a deal-breaker field and a way, and nothing else", () => {
    expect(Relaxation.parse({ field: "smoking", kind: "aside" })).toEqual({
      field: "smoking",
      kind: "aside",
    });
    expect(codes(Relaxation, { field: "intent", kind: "aside" })).toEqual(["invalid_value"]);
    expect(codes(Relaxation, { field: "smoking", kind: "widen" })).toEqual(["invalid_value"]);
    expect(codes(Relaxation, { field: "smoking", kind: "aside", note: "x" })).toEqual([
      "unrecognized_keys",
    ]);
  });

  it("offers a figure of the pool, whole and never negative", () => {
    expect(RelaxationOffer.parse({ field: "smoking", kind: "aside", more: 20 }).more).toBe(20);
    expect(codes(RelaxationOffer, { field: "smoking", kind: "aside", more: -10 })).toEqual([
      "too_small",
    ]);
    expect(codes(RelaxationOffer, { field: "smoking", kind: "aside", more: 2.5 })).toEqual([
      "invalid_type",
    ]);
  });

  it("answers what is offered and what is relaxed, bounded by the deal-breakers' ceiling", () => {
    const offer = { field: "smoking", kind: "aside", more: 0 } as const;
    expect(RelaxationsResponse.parse({ short: true, offers: [offer], relaxed: [] }).offers).toEqual(
      [offer],
    );
    const each = Array(DEAL_BREAKERS_CAP * 2).fill(offer);
    expect(codes(RelaxationsResponse, { short: true, offers: each, relaxed: [] })).toEqual([]);
    expect(
      codes(RelaxationsResponse, { short: true, offers: [...each, offer], relaxed: [] }),
    ).toEqual(["too_big"]);
    expect(codes(RelaxationsResponse, { short: true, offers: [], relaxed: [], count: 3 })).toEqual([
      "unrecognized_keys",
    ]);
  });

  it("answers the first cards added, a page at most, and the places undone (ADR-062 §10)", () => {
    expect(RelaxationAnswer.parse({ entries: [] })).toEqual({ entries: [] });
    const tooMany = Array.from({ length: QUEUE_PAGE + 1 }, () => ({}));
    expect(codes(RelaxationAnswer, { entries: tooMany })).toContain("too_big");
    expect(RelaxationUndone.parse({ removed: [2, 3] })).toEqual({ removed: [2, 3] });
    expect(codes(RelaxationUndone, { removed: [0] })).toEqual(["too_small"]);
    expect(codes(RelaxationUndone, { removed: [ROUND_POSITION_MAX + 1] })).toEqual(["too_big"]);
  });

  it("addresses a relaxation by its round's day and its field", () => {
    expect(RelaxationParams.parse({ day: "2026-10-21", field: "languages" })).toEqual({
      day: "2026-10-21",
      field: "languages",
    });
    expect(codes(RelaxationParams, { day: "21.10.2026", field: "smoking" })).toEqual([
      "invalid_format",
    ]);
    expect(codes(RoundDayParams, { day: "2026-13-01" })).toEqual(["invalid_format"]);
  });

  it("lets a card carry the field it came in by and who did not answer, or neither, as an older API sends it", () => {
    const card = RoundEntry.shape.card;
    const base = { position: 1, reason: "relaxed", decision: null, distance: null };
    expect(RoundEntry.shape.relaxedField.safeParse(undefined).success).toBe(true);
    expect(RoundEntry.shape.notAnswered.safeParse(["smoking", "languages"]).success).toBe(true);
    expect(RoundEntry.shape.notAnswered.safeParse(["intent"]).success).toBe(false);
    expect(card).toBeDefined();
    expect(codes(RoundEntry.omit({ card: true }), { ...base, relaxedField: "nicotine" })).toEqual([
      "invalid_value",
    ]);
  });

  it("names the relaxed field in the export, or nothing", () => {
    const entry = {
      position: 1,
      reason: "relaxed",
      reasonInWords: "There because you relaxed a filter",
      relaxedField: "smoking",
      relaxedFieldInWords: "Smoking",
      seenAt: null,
      decision: null,
      decisionInWords: null,
      decidedAt: null,
      secondPass: false,
      distance: "nearby",
      distanceInWords: "Nearby",
    };
    expect(ExportedRoundEntry.parse(entry).relaxedField).toBe("smoking");
    // Null on an entry from before the band; never a number, nor a word of no band.
    expect(
      ExportedRoundEntry.parse({ ...entry, distance: null, distanceInWords: null }).distance,
    ).toBeNull();
    expect(ExportedRoundEntry.safeParse({ ...entry, distance: 4 }).success).toBe(false);
    expect(ExportedRoundEntry.safeParse({ ...entry, distance: "next door" }).success).toBe(false);
    expect(
      ExportedRoundEntry.parse({ ...entry, relaxedField: null, relaxedFieldInWords: null })
        .relaxedField,
    ).toBeNull();
    expect(codes(ExportedRoundEntry, { ...entry, relaxedField: undefined })).toEqual([
      "invalid_value",
    ]);
  });

  it("says a skip and a second pass in the export (ADR-062 §3, §6)", () => {
    const entry = {
      position: 3,
      reason: "matches_filters",
      reasonInWords: "Fits what you seek",
      relaxedField: null,
      relaxedFieldInWords: null,
      seenAt: null,
      decision: "skip",
      decisionInWords: "Later",
      decidedAt: "2026-10-19T09:00:00.000Z",
      secondPass: false,
      distance: null,
      distanceInWords: null,
    };
    expect(ExportedRoundEntry.parse(entry).decision).toBe("skip");
    const second = { ...entry, decision: "pass", decisionInWords: "Pass", secondPass: true };
    expect(ExportedRoundEntry.parse(second).secondPass).toBe(true);
    expect(codes(ExportedRoundEntry, { ...entry, secondPass: undefined })).toEqual([
      "invalid_type",
    ]);
    expect(codes(ExportedRoundEntry, { ...entry, secondPass: 1 })).toEqual(["invalid_type"]);
  });
});
