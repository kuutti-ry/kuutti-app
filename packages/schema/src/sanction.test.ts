import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  BanRequest,
  ExportedSanction,
  SANCTION_NOTE_MAX,
  Sanction,
  SanctionAccountParams,
  SanctionEntry,
  SanctionKind,
  SanctionList,
  SanctionParams,
  SanctionReason,
  SanctionRequest,
  SanctionReviewRequest,
  SUSPENSION_DAYS_MAX,
} from "./sanction.ts";

// The sanctions contract (#307, ADR-024): what staff send, what the panel
// reads, and what the person's export holds, at their boundaries.

const codes = (schema: z.ZodType, input: unknown) =>
  schema.safeParse(input).error?.issues.map((issue) => issue.code) ?? [];

const at = "2026-10-20T09:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const note = "Wrote something unkind in two chats";

describe("the kinds and the reasons", () => {
  it("are the closed lists of ADR-024 §1 and §3, in the database's order", () => {
    expect(SanctionKind.options).toEqual(["warn", "shadow_ban", "suspend", "ban"]);
    expect(SanctionReason.options).toEqual([
      "harassment",
      "misrepresentation",
      "under_age",
      "commercial_use",
      "scraping",
      "other",
    ]);
  });

  it("refuse a kind or a reason outside the lists", () => {
    expect(codes(SanctionKind, "mute")).toEqual(["invalid_value"]);
    expect(codes(SanctionReason, "spam")).toEqual(["invalid_value"]);
    expect(codes(SanctionReason, "")).toEqual(["invalid_value"]);
  });

  it("keep a note to 500 characters and a suspension to 366 days ahead", () => {
    expect(SANCTION_NOTE_MAX).toBe(500);
    expect(SUSPENSION_DAYS_MAX).toBe(366);
  });
});

describe("a moderator's sanction", () => {
  const warn = { kind: "warn", reason: "harassment", note };
  const suspend = { kind: "suspend", reason: "commercial_use", note, endsOn: "2026-10-22" };

  it("takes a warning, a shadow ban and a suspension with its day, for every reason", () => {
    for (const reason of SanctionReason.options) {
      expect(SanctionRequest.parse({ ...warn, reason })).toEqual({ ...warn, reason });
      expect(SanctionRequest.parse({ ...warn, kind: "shadow_ban", reason }).kind).toBe(
        "shadow_ban",
      );
      expect(SanctionRequest.parse({ ...suspend, reason })).toEqual({ ...suspend, reason });
    }
  });

  it("takes a note of one character and of 500, trimmed, and refuses 501 or only whitespace", () => {
    expect(SanctionRequest.parse({ ...warn, note: "x" }).note).toBe("x");
    const full = "x".repeat(SANCTION_NOTE_MAX);
    expect(SanctionRequest.parse({ ...warn, note: full }).note).toBe(full);
    // Whitespace around the words is not counted, and not kept.
    expect(SanctionRequest.parse({ ...warn, note: `  ${full}\n` }).note).toBe(full);
    expect(SanctionRequest.parse({ ...warn, note: "  two words \t" }).note).toBe("two words");
    expect(codes(SanctionRequest, { ...warn, note: `${full}x` })).toEqual(["too_big"]);
    expect(codes(SanctionRequest, { ...warn, note: "" })).toEqual(["too_small"]);
    expect(codes(SanctionRequest, { ...warn, note: " \n\t " })).toEqual(["too_small"]);
    expect(codes(SanctionRequest, { ...warn, note: 7 })).toEqual(["invalid_type"]);
  });

  it.each([
    ["the Finnish way of writing it", "22.10.2026", "invalid_format"],
    ["an instant instead of a day", "2026-10-22T00:00:00Z", "invalid_format"],
    ["a day that does not exist", "2026-02-30", "invalid_format"],
    ["a month that does not exist", "2026-13-01", "invalid_format"],
    ["no leading zero", "2026-10-2", "invalid_format"],
    ["an empty string", "", "invalid_format"],
    ["a number", 20261022, "invalid_type"],
    ["nothing", undefined, "invalid_type"],
  ])("refuses a suspension's end as %s", (_what, endsOn, code) => {
    expect(codes(SanctionRequest, { ...suspend, endsOn })).toEqual([code]);
  });

  it("takes a leap day as a suspension's end; how far ahead is the route's check", () => {
    expect(SanctionRequest.parse({ ...suspend, endsOn: "2028-02-29" })).toMatchObject({
      endsOn: "2028-02-29",
    });
  });

  it("refuses an end on a warning or a shadow ban, and any key it does not define", () => {
    expect(codes(SanctionRequest, { ...warn, endsOn: "2026-10-22" })).toEqual([
      "unrecognized_keys",
    ]);
    expect(codes(SanctionRequest, { ...warn, kind: "shadow_ban", endsOn: "2026-10-22" })).toEqual([
      "unrecognized_keys",
    ]);
    expect(codes(SanctionRequest, { ...suspend, accountId: uuid(1) })).toEqual([
      "unrecognized_keys",
    ]);
  });

  it("refuses a ban, which has its own route, and a kind it does not know or none", () => {
    expect(codes(SanctionRequest, { ...warn, kind: "ban" })).toEqual(["invalid_union"]);
    expect(codes(SanctionRequest, { ...warn, kind: "mute" })).toEqual(["invalid_union"]);
    expect(codes(SanctionRequest, { reason: "harassment", note })).toEqual(["invalid_union"]);
    expect(codes(SanctionRequest, null)).toEqual(["invalid_type"]);
  });

  it("refuses a missing reason or note, and a reason outside the list", () => {
    expect(codes(SanctionRequest, { kind: "warn", note })).toEqual(["invalid_value"]);
    expect(codes(SanctionRequest, { kind: "warn", reason: "harassment" })).toEqual([
      "invalid_type",
    ]);
    expect(codes(SanctionRequest, { ...suspend, reason: "rudeness" })).toEqual(["invalid_value"]);
  });
});

describe("an admin's ban", () => {
  const ban = { reason: "misrepresentation", note };

  it("takes a reason and a trimmed note, and nothing else", () => {
    expect(BanRequest.parse({ ...ban, note: `  ${note}  ` })).toEqual(ban);
    expect(codes(BanRequest, { ...ban, kind: "ban" })).toEqual(["unrecognized_keys"]);
    expect(codes(BanRequest, { ...ban, endsOn: "2026-10-22" })).toEqual(["unrecognized_keys"]);
  });

  it("holds the note to between one and 500 characters", () => {
    expect(BanRequest.safeParse({ ...ban, note: "x" }).success).toBe(true);
    expect(BanRequest.safeParse({ ...ban, note: "x".repeat(500) }).success).toBe(true);
    expect(codes(BanRequest, { ...ban, note: "x".repeat(501) })).toEqual(["too_big"]);
    expect(codes(BanRequest, { ...ban, note: "   " })).toEqual(["too_small"]);
  });

  it("refuses a reason outside the list and a missing one", () => {
    expect(codes(BanRequest, { ...ban, reason: "rudeness" })).toEqual(["invalid_value"]);
    expect(codes(BanRequest, { note })).toEqual(["invalid_value"]);
    expect(codes(BanRequest, { reason: "other" })).toEqual(["invalid_type"]);
  });
});

describe("a second look", () => {
  const review = { note: "Read the chats again", outcome: "keep" };

  it("keeps or lifts, with a trimmed note, and nothing else", () => {
    expect(SanctionReviewRequest.parse(review)).toEqual(review);
    expect(SanctionReviewRequest.parse({ ...review, outcome: "lift", note: " ok " })).toEqual({
      note: "ok",
      outcome: "lift",
    });
    expect(codes(SanctionReviewRequest, { ...review, outcome: "reject" })).toEqual([
      "invalid_value",
    ]);
    expect(codes(SanctionReviewRequest, { note: review.note })).toEqual(["invalid_value"]);
    expect(codes(SanctionReviewRequest, { ...review, sanctionId: uuid(2) })).toEqual([
      "unrecognized_keys",
    ]);
  });

  it("holds the note to between one and 500 characters", () => {
    expect(SanctionReviewRequest.safeParse({ ...review, note: "x".repeat(500) }).success).toBe(
      true,
    );
    expect(codes(SanctionReviewRequest, { ...review, note: "x".repeat(501) })).toEqual(["too_big"]);
    expect(codes(SanctionReviewRequest, { ...review, note: "" })).toEqual(["too_small"]);
    expect(codes(SanctionReviewRequest, { outcome: "keep" })).toEqual(["invalid_type"]);
  });
});

describe("the route parameters", () => {
  it.each([
    ["a sanction", SanctionParams],
    ["an account", SanctionAccountParams],
  ] as const)("name %s by a uuid and nothing else", (_what, schema) => {
    expect(schema.parse({ id: uuid(3) })).toEqual({ id: uuid(3) });
    expect(codes(schema, { id: "not-a-uuid" })).toEqual(["invalid_format"]);
    expect(codes(schema, { id: "" })).toEqual(["invalid_format"]);
    expect(codes(schema, {})).toEqual(["invalid_type"]);
  });
});

describe("the panel's sanction", () => {
  const item = {
    id: uuid(10),
    accountId: uuid(11),
    kind: "suspend",
    reason: "commercial_use",
    note,
    endsAt: "2026-10-21T21:00:00.000Z",
    createdBy: uuid(12),
    createdAt: at,
    liftedAt: at,
    liftedBy: uuid(13),
    reviewNote: "Lifted early",
    reviewedBy: uuid(14),
    reviewedAt: at,
  };

  it("reads a sanction with who did what, and one that no person applied or lifted", () => {
    expect(Sanction.parse(item)).toEqual(item);
    const byNobody = {
      ...item,
      kind: "ban",
      endsAt: null,
      createdBy: null,
      liftedAt: null,
      liftedBy: null,
      reviewNote: null,
      reviewedBy: null,
      reviewedAt: null,
    };
    expect(Sanction.parse(byNobody)).toEqual(byNobody);
  });

  it("holds the notes to 500 characters, the ids to uuids and the times to ISO 8601", () => {
    expect(Sanction.safeParse({ ...item, note: "x".repeat(500) }).success).toBe(true);
    expect(codes(Sanction, { ...item, note: "x".repeat(501) })).toEqual(["too_big"]);
    expect(codes(Sanction, { ...item, reviewNote: "x".repeat(501) })).toEqual(["too_big"]);
    expect(codes(Sanction, { ...item, createdBy: "staff" })).toEqual(["invalid_format"]);
    expect(codes(Sanction, { ...item, endsAt: "22.10.2026" })).toEqual(["invalid_format"]);
    expect(codes(Sanction, { ...item, kind: "mute" })).toEqual(["invalid_value"]);
    expect(codes(Sanction, { ...item, liftedAt: undefined })).toEqual(["invalid_type"]);
  });

  /** A sanction as the person's page lists it (#308): the plain one with the staff's roles now. */
  const entry = {
    ...item,
    createdByRole: "moderator",
    liftedByRole: null,
    reviewedByRole: "admin",
  };

  it("lists at most 1000 of them", () => {
    expect(SanctionList.parse({ items: [] })).toEqual({ items: [] });
    expect(
      SanctionList.safeParse({ items: Array.from({ length: 1000 }, () => entry) }).success,
    ).toBe(true);
    expect(codes(SanctionList, { items: Array.from({ length: 1001 }, () => entry) })).toEqual([
      "too_big",
    ]);
  });

  it("lists each with the staff's roles now, each a role or null, none left out (#308)", () => {
    expect(SanctionEntry.parse(entry)).toEqual(entry);
    for (const role of ["moderator", "admin", "researcher", null]) {
      expect(SanctionEntry.safeParse({ ...entry, liftedByRole: role }).success).toBe(true);
    }
    expect(codes(SanctionEntry, { ...entry, createdByRole: "owner" })).toEqual(["invalid_value"]);
    for (const key of ["createdByRole", "liftedByRole", "reviewedByRole"]) {
      expect(codes(SanctionEntry, { ...entry, [key]: undefined })).toEqual(["invalid_value"]);
    }
    // A plain sanction, as the writes answer it, is not a listed one.
    expect(SanctionList.safeParse({ items: [item] }).success).toBe(false);
  });
});

describe("a sanction in the person's export", () => {
  const exported = {
    kind: "warn",
    kindInWords: "A warning",
    reason: "harassment",
    reasonInWords: "Harassment",
    appliedAt: at,
    endsAt: null,
    liftedAt: null,
    lookedAtAgain: false,
  };

  it("keeps kind, reason, the dates and whether somebody looked again", () => {
    expect(ExportedSanction.parse(exported)).toEqual(exported);
    const suspension = {
      ...exported,
      kind: "suspend",
      endsAt: "2026-10-21T21:00:00.000Z",
      liftedAt: at,
      lookedAtAgain: true,
    };
    expect(ExportedSanction.parse(suspension)).toEqual(suspension);
  });

  it("drops who and staff's words, so a stray column never reaches the file (ADR-024 §8)", () => {
    const leaky = {
      ...exported,
      note,
      createdBy: uuid(12),
      liftedBy: uuid(13),
      reviewedBy: uuid(14),
      reviewNote: "Lifted early",
    };
    expect(ExportedSanction.parse(leaky)).toEqual(exported);
  });

  it("refuses a kind or a reason outside the lists, a time that is not ISO 8601, and a look that is not a yes or a no", () => {
    expect(codes(ExportedSanction, { ...exported, kind: "mute" })).toEqual(["invalid_value"]);
    expect(codes(ExportedSanction, { ...exported, reason: "spam" })).toEqual(["invalid_value"]);
    expect(codes(ExportedSanction, { ...exported, appliedAt: "20.10.2026" })).toEqual([
      "invalid_format",
    ]);
    expect(codes(ExportedSanction, { ...exported, lookedAtAgain: "no" })).toEqual(["invalid_type"]);
    expect(codes(ExportedSanction, { ...exported, kindInWords: undefined })).toEqual([
      "invalid_type",
    ]);
  });
});
