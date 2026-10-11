import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AdminAuthExchangeRequest,
  AdminAuthStartQuery,
  AdminSession,
  AdminWhoAmI,
  ModerationLabel,
  ModeratorRole,
  PhotoDecisionRequest,
  PhotoDecisionResponse,
  PhotoReviewItem,
  PhotoReviewQueue,
  PhotoReviewQueueQuery,
} from "./admin.ts";

// The moderation panel's contracts (#49, rules/admin.md) at their boundaries.

const codes = (schema: z.ZodType, input: unknown) =>
  schema.safeParse(input).error?.issues.map((issue) => issue.code) ?? [];

const token = "A".repeat(43);
const at = "2026-10-01T12:00:00.000Z";
const photoId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";

describe("the staff sign-in", () => {
  it.each(["moderator", "admin", "researcher"])("knows the role %s", (role) => {
    expect(ModeratorRole.parse(role)).toBe(role);
  });

  it("knows no other role", () => {
    expect(codes(ModeratorRole, "owner")).toEqual(["invalid_value"]);
  });

  it("takes the bank chooser's language, or none", () => {
    expect(AdminAuthStartQuery.parse({})).toEqual({});
    for (const locale of ["fi", "sv", "en"]) {
      expect(AdminAuthStartQuery.parse({ locale })).toEqual({ locale });
    }
    expect(codes(AdminAuthStartQuery, { locale: "de" })).toEqual(["invalid_value"]);
  });

  it.each([
    ["43 base64url characters", "abcDEF0123456789_-".padEnd(43, "x"), true],
    ["42 characters", "A".repeat(42), false],
    ["44 characters", "A".repeat(44), false],
    ["a plus sign of plain base64", `${"A".repeat(42)}+`, false],
    ["base64 padding", `${"A".repeat(42)}=`, false],
    ["nothing", "", false],
  ])("exchanges a one-time code of %s: %s", (_, code, ok) => {
    expect(AdminAuthExchangeRequest.safeParse({ code }).success).toBe(ok);
  });

  it("refuses an exchange with an extra field", () => {
    expect(codes(AdminAuthExchangeRequest, { code: token, role: "admin" })).toEqual([
      "unrecognized_keys",
    ]);
  });

  it("hands out a session of one token, its end and the role", () => {
    const session = { accessToken: token, expiresAt: at, role: "moderator" };
    expect(AdminSession.parse(session)).toEqual(session);
    expect(codes(AdminSession, { ...session, accessToken: "short" })).toEqual(["invalid_format"]);
    expect(codes(AdminSession, { ...session, expiresAt: "tomorrow" })).toEqual(["invalid_format"]);
    expect(AdminWhoAmI.parse({ role: "admin", expiresAt: at })).toEqual({
      role: "admin",
      expiresAt: at,
    });
  });
});

describe("a moderation label", () => {
  const label = { name: "Explicit", parentName: "", confidence: 0 };

  it("takes a confidence from 0 to 100 and an empty parent", () => {
    expect(ModerationLabel.parse(label)).toEqual(label);
    expect(ModerationLabel.parse({ ...label, confidence: 100 }).confidence).toBe(100);
    expect(ModerationLabel.parse({ ...label, confidence: 99.97 }).confidence).toBe(99.97);
  });

  it.each([
    ["a confidence below 0", { confidence: -0.01 }, "too_small"],
    ["a confidence above 100", { confidence: 100.01 }, "too_big"],
    ["an empty name", { name: "" }, "too_small"],
    ["a name of 101 characters", { name: "n".repeat(101) }, "too_big"],
    ["a parent of 101 characters", { parentName: "p".repeat(101) }, "too_big"],
  ])("refuses %s", (_, change, code) => {
    expect(codes(ModerationLabel, { ...label, ...change })).toEqual([code]);
  });

  it("takes a name of exactly 100 characters", () => {
    expect(ModerationLabel.safeParse({ ...label, name: "n".repeat(100) }).success).toBe(true);
  });
});

describe("the review queue", () => {
  const item = {
    photoId,
    accountId,
    state: "queued",
    blurhash: "LEHV6n",
    width: 1,
    height: 1,
    uploadedAt: at,
    checkedAt: null,
    labels: [],
    faces: 0,
    flagged: [],
  };

  it("lists a photo with what the automatic check saw", () => {
    expect(PhotoReviewItem.parse(item)).toEqual(item);
  });

  it.each([
    ["a blurhash of five characters", { blurhash: "LEHV6" }, "too_small"],
    ["a blurhash of 201 characters", { blurhash: "L".repeat(201) }, "too_big"],
    ["a width of zero", { width: 0 }, "too_small"],
    ["a fractional height", { height: 1.5 }, "invalid_type"],
    ["a negative face count", { faces: -1 }, "too_small"],
    [
      "51 labels",
      { labels: Array(51).fill({ name: "x", parentName: "", confidence: 1 }) },
      "too_big",
    ],
    ["51 flags", { flagged: Array(51).fill("x") }, "too_big"],
    ["a flag of 101 characters", { flagged: ["f".repeat(101)] }, "too_big"],
    ["an account id that is not a uuid", { accountId: "acc-1" }, "invalid_format"],
    ["a state outside the list", { state: "hidden" }, "invalid_value"],
  ])("refuses an item with %s", (_, change, code) => {
    expect(codes(PhotoReviewItem, { ...item, ...change })).toEqual([code]);
  });

  it("holds a page of at most a hundred and the total beyond it", () => {
    expect(PhotoReviewQueue.parse({ items: Array(100).fill(item), total: 250 }).total).toBe(250);
    expect(codes(PhotoReviewQueue, { items: Array(101).fill(item), total: 101 })).toEqual([
      "too_big",
    ]);
    expect(codes(PhotoReviewQueue, { items: [], total: -1 })).toEqual(["too_small"]);
  });

  it.each([
    [{}, 20],
    [{ limit: "1" }, 1],
    [{ limit: "100" }, 100],
    [{ limit: 7 }, 7],
  ])("reads the page size %o as %i", (query, limit) => {
    expect(PhotoReviewQueueQuery.parse(query)).toEqual({ limit });
  });

  it.each(["0", "101", "2.5", "many", "-3"])("refuses the page size %s", (limit) => {
    expect(PhotoReviewQueueQuery.safeParse({ limit }).success).toBe(false);
  });
});

describe("a moderator's decision", () => {
  it("approves without a reason", () => {
    expect(PhotoDecisionRequest.parse({ decision: "approve" })).toEqual({ decision: "approve" });
  });

  it.each([
    "nudity",
    "no_person",
    "several_people",
    "minor",
    "violence",
    "contact_details",
    "other",
  ])("rejects for the reason %s", (reason) => {
    expect(PhotoDecisionRequest.parse({ decision: "reject", reason })).toEqual({
      decision: "reject",
      reason,
    });
  });

  it.each([
    ["a rejection without a reason", { decision: "reject" }],
    ["a rejection for a reason outside the list", { decision: "reject", reason: "ugly" }],
    ["an approval that carries a reason", { decision: "approve", reason: "other" }],
    ["a decision outside the two", { decision: "queue" }],
    ["no decision", {}],
  ])("refuses %s", (_, body) => {
    expect(PhotoDecisionRequest.safeParse(body).success).toBe(false);
  });

  it("answers with the photo's new state and the reason when rejected", () => {
    const answer = { photoId, state: "rejected", rejectionReason: "violence" };
    expect(PhotoDecisionResponse.parse(answer)).toEqual(answer);
    expect(
      PhotoDecisionResponse.parse({ photoId, state: "approved", rejectionReason: null })
        .rejectionReason,
    ).toBeNull();
    expect(codes(PhotoDecisionResponse, { ...answer, photoId: "p1" })).toEqual(["invalid_format"]);
  });
});
