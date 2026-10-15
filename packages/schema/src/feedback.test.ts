import { describe, expect, it } from "vitest";
import {
  FEEDBACK_KIND_ORDER,
  FEEDBACK_TEXT_MAX,
  FeedbackItem,
  FeedbackKind,
  FeedbackListQuery,
  FeedbackRequest,
} from "./feedback.ts";

// The feedback contract (#171, ADR-023): four kinds, a bounded text, what the app reads.

const request = {
  kind: "bug",
  text: "The photos screen shows yesterday's tip.",
  appVersion: "0.22.0",
  platform: "ios",
  locale: "fi",
};

describe("the feedback kinds", () => {
  it("are four, and the panel's order names each once", () => {
    expect(FeedbackKind.options).toEqual(["bug", "idea", "complaint", "praise"]);
    expect([...FEEDBACK_KIND_ORDER].sort()).toEqual([...FeedbackKind.options].sort());
    expect(FEEDBACK_KIND_ORDER[0]).toBe("bug");
    expect(FEEDBACK_KIND_ORDER.at(-1)).toBe("praise");
  });
});

describe("the request", () => {
  it("takes a kind, the trimmed text, the build, the platform and the locale, and nothing else", () => {
    const parsed = FeedbackRequest.parse({ ...request, text: "  a few lines  " });
    expect(parsed.text).toBe("a few lines");
    expect(FeedbackRequest.safeParse({ ...request, extra: 1 }).success).toBe(false);
  });

  it.each([
    ["an empty text", { text: "" }],
    ["a text of spaces", { text: "   " }],
    ["a text over the cap", { text: "x".repeat(FEEDBACK_TEXT_MAX + 1) }],
    ["an unknown kind", { kind: "question" }],
    ["an unknown platform", { platform: "windows" }],
    ["a locale too short", { locale: "f" }],
    ["a locale too long", { locale: "x".repeat(17) }],
    ["no version", { appVersion: "" }],
    ["a missing kind", { kind: undefined }],
  ])("refuses %s", (_what, patch) => {
    expect(FeedbackRequest.safeParse({ ...request, ...patch }).success).toBe(false);
  });

  it("takes a text at the cap, the pseudo-locale, and every kind and platform", () => {
    expect(
      FeedbackRequest.safeParse({ ...request, text: "x".repeat(FEEDBACK_TEXT_MAX) }).success,
    ).toBe(true);
    expect(FeedbackRequest.safeParse({ ...request, locale: "en-XA" }).success).toBe(true);
    for (const kind of FeedbackKind.options) {
      for (const platform of ["ios", "android", "web"]) {
        expect(FeedbackRequest.safeParse({ ...request, kind, platform }).success).toBe(true);
      }
    }
  });
});

describe("the panel's contracts", () => {
  it("read an item with its times, and a page size with a default and a ceiling", () => {
    const item = FeedbackItem.parse({
      id: "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01",
      accountId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
      ...request,
      createdAt: "2026-10-15T12:00:00.000Z",
      handledAt: null,
    });
    expect(item.handledAt).toBeNull();
    expect(FeedbackListQuery.parse({})).toEqual({ limit: 50 });
    expect(FeedbackListQuery.parse({ limit: "100" })).toEqual({ limit: 100 });
    expect(FeedbackListQuery.safeParse({ limit: 101 }).success).toBe(false);
    expect(FeedbackListQuery.safeParse({ limit: 0 }).success).toBe(false);
  });
});
