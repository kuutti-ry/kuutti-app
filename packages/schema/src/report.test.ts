import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  BlockRequest,
  ConversationReportRequest,
  ExportedBlocks,
  ExportedReport,
  ExportedReports,
  REPORT_NOTE_MAX,
  ReportCopyLine,
  ReportCopyPhotoParams,
  ReportDecisionRequest,
  ReportOutcome,
  ReportQueueQuery,
  ReportRequest,
} from "./report.ts";

// The reports and blocks contract (#84, ADR-030): what the app sends, and
// what the reporter's export holds, at their boundaries.

const codes = (schema: z.ZodType, input: unknown) =>
  schema.safeParse(input).error?.issues.map((issue) => issue.code) ?? [];

const id = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const at = "2026-10-20T09:00:00.000Z";

describe("a block", () => {
  it("names one account and nothing else", () => {
    expect(BlockRequest.parse({ accountId: id })).toEqual({ accountId: id });
    expect(codes(BlockRequest, {})).toEqual(["invalid_type"]);
    expect(codes(BlockRequest, { accountId: "not-a-uuid" })).toEqual(["invalid_format"]);
    expect(codes(BlockRequest, { accountId: id, reason: "other" })).toEqual(["unrecognized_keys"]);
  });
});

describe("a report", () => {
  it.each([
    "harassment",
    "misrepresentation",
    "under_age",
    "commercial_use",
    "scraping",
    "other",
  ] as const)("takes the reason %s, with or without a note", (reason) => {
    expect(ReportRequest.parse({ accountId: id, reason })).toEqual({ accountId: id, reason });
    expect(ReportRequest.parse({ accountId: id, reason, note: "  He asked for money.  " })).toEqual(
      { accountId: id, reason, note: "He asked for money." },
    );
  });

  it("holds the note to its bounds after trimming", () => {
    const note = (text: string) =>
      ReportRequest.safeParse({ accountId: id, reason: "other", note: text });
    expect(note("x".repeat(REPORT_NOTE_MAX)).success).toBe(true);
    expect(
      codes(ReportRequest, {
        accountId: id,
        reason: "other",
        note: "x".repeat(REPORT_NOTE_MAX + 1),
      }),
    ).toEqual(["too_big"]);
    expect(codes(ReportRequest, { accountId: id, reason: "other", note: "   " })).toEqual([
      "too_small",
    ]);
    expect(codes(ReportRequest, { accountId: id, reason: "other", note: "" })).toEqual([
      "too_small",
    ]);
  });

  it("refuses a missing or unknown reason, a missing account and an unknown key", () => {
    expect(codes(ReportRequest, { accountId: id })).toEqual(["invalid_value"]);
    expect(codes(ReportRequest, { accountId: id, reason: "rude" })).toEqual(["invalid_value"]);
    expect(codes(ReportRequest, { reason: "other" })).toEqual(["invalid_type"]);
    expect(codes(ReportRequest, { accountId: id, reason: "other", source: "card" })).toEqual([
      "unrecognized_keys",
    ]);
  });
});

describe("a report from a conversation (#351)", () => {
  it("takes the card's reason and note, the conversation naming whom", () => {
    expect(ConversationReportRequest.parse({ reason: "harassment" })).toEqual({
      reason: "harassment",
    });
    expect(ConversationReportRequest.parse({ reason: "other", note: "  Kysyi rahaa.  " })).toEqual({
      reason: "other",
      note: "Kysyi rahaa.",
    });
    expect(
      ConversationReportRequest.safeParse({ reason: "other", note: "x".repeat(REPORT_NOTE_MAX) })
        .success,
    ).toBe(true);
  });

  it("refuses an account, a missing or unknown reason, a note out of bounds and an unknown key", () => {
    expect(codes(ConversationReportRequest, { accountId: id, reason: "other" })).toEqual([
      "unrecognized_keys",
    ]);
    expect(codes(ConversationReportRequest, {})).toEqual(["invalid_value"]);
    expect(codes(ConversationReportRequest, { reason: "rude" })).toEqual(["invalid_value"]);
    expect(codes(ConversationReportRequest, { reason: "other", note: " " })).toEqual(["too_small"]);
    expect(
      codes(ConversationReportRequest, { reason: "other", note: "x".repeat(REPORT_NOTE_MAX + 1) }),
    ).toEqual(["too_big"]);
  });
});

describe("the reporter's export", () => {
  const report = {
    at,
    source: "card",
    reason: "harassment",
    reasonInWords: "Harassment",
    note: null,
    outcome: null,
    outcomeInWords: "Waiting for a moderator",
    decidedAt: null,
  } as const;

  it("says the outcome or that it waits, and names nobody", () => {
    expect(ExportedReport.parse(report)).toEqual(report);
    for (const outcome of ReportOutcome.options) {
      expect(ExportedReport.safeParse({ ...report, outcome, decidedAt: at }).success).toBe(true);
    }
    expect(Object.keys(ExportedReport.shape)).not.toContain("accountId");
    // Where it was made, from the closed list; the conversation's copy is in nobody's export (#351).
    expect(ExportedReport.parse({ ...report, source: "conversation" }).source).toBe("conversation");
    expect(codes(ExportedReport, { ...report, source: "profile" })).toEqual(["invalid_value"]);
    expect(codes(ExportedReport, { ...report, source: undefined })).toEqual(["invalid_value"]);
    expect(Object.keys(ExportedReport.shape)).not.toContain("messages");
    expect(ExportedReports.parse({ about: "x", items: [report] }).items).toHaveLength(1);
    expect(ExportedBlocks.parse({ about: "x", items: [{ at }] }).items).toEqual([{ at }]);
  });

  it("is bounded", () => {
    expect(codes(ExportedReports, { about: "x", items: Array(1001).fill(report) })).toEqual([
      "too_big",
    ]);
    expect(codes(ExportedBlocks, { about: "x", items: Array(1001).fill({ at }) })).toEqual([
      "too_big",
    ]);
    expect(codes(ExportedReport, { ...report, note: "x".repeat(REPORT_NOTE_MAX + 1) })).toEqual([
      "too_big",
    ]);
  });
});

describe("the moderators' queue and decision (#311, #312)", () => {
  it("reads the open reports by default, fifty at a time, and refuses another state or a page out of bounds", () => {
    expect(ReportQueueQuery.parse({})).toEqual({ state: "open", limit: 50 });
    expect(ReportQueueQuery.parse({ state: "closed", limit: "100" })).toEqual({
      state: "closed",
      limit: 100,
    });
    expect(codes(ReportQueueQuery, { state: "pending" })).toEqual(["invalid_value"]);
    expect(codes(ReportQueueQuery, { limit: "0" })).toEqual(["too_small"]);
    expect(codes(ReportQueueQuery, { limit: "101" })).toEqual(["too_big"]);
  });

  it("names a photo of the copy by its line, a positive sequence number", () => {
    expect(ReportCopyPhotoParams.parse({ id, seq: "3" })).toEqual({ id, seq: 3 });
    expect(codes(ReportCopyPhotoParams, { id, seq: "0" })).toEqual(["too_small"]);
    expect(codes(ReportCopyPhotoParams, { id, seq: String(2 ** 31) })).toEqual(["too_big"]);
    expect(codes(ReportCopyPhotoParams, { id, seq: "1.5" })).toEqual(["invalid_type"]);
    expect(codes(ReportCopyPhotoParams, { id: "x", seq: "1" })).toEqual(["invalid_format"]);
  });

  it("dismisses with nothing more, and acts only naming a sanction", () => {
    expect(ReportDecisionRequest.parse({ outcome: "dismissed" })).toEqual({ outcome: "dismissed" });
    expect(ReportDecisionRequest.parse({ outcome: "acted", sanctionId: id })).toEqual({
      outcome: "acted",
      sanctionId: id,
    });
    expect(codes(ReportDecisionRequest, { outcome: "acted" })).toEqual(["invalid_type"]);
    expect(codes(ReportDecisionRequest, { outcome: "dismissed", sanctionId: id })).toEqual([
      "unrecognized_keys",
    ]);
    expect(codes(ReportDecisionRequest, { outcome: "ignored" })).toEqual(["invalid_union"]);
    expect(codes(ReportDecisionRequest, { outcome: "acted", sanctionId: "warn-1" })).toEqual([
      "invalid_format",
    ]);
  });

  it("carries a copied line's words and whether a photo is held, never the photo itself", () => {
    const line = {
      seq: 1,
      side: "reported",
      kind: "photo",
      body: null,
      photo: true,
      createdAt: at,
    };
    expect(ReportCopyLine.parse({ ...line, photoId: id })).toEqual(line);
    expect(codes(ReportCopyLine, { ...line, side: "a" })).toEqual(["invalid_value"]);
  });
});
