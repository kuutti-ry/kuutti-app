import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  BlockRequest,
  ExportedBlocks,
  ExportedReport,
  ExportedReports,
  REPORT_NOTE_MAX,
  ReportOutcome,
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

describe("the reporter's export", () => {
  const report = {
    at,
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
