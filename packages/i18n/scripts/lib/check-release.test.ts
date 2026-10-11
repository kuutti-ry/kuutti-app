import { describe, expect, it, vi } from "vitest";
import { reviewHash } from "./review-hash.ts";
import type { Messages } from "./schema.ts";

// The day Swedish is released (#55): releasing it is adding it to
// RELEASED_LOCALES, and from then on a release holds Swedish to what it holds
// Finnish. The module is loaded with that list here; today's list is the
// existing suite's.
vi.mock("../../src/locales.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/locales.ts")>()),
  RELEASED_LOCALES: ["en", "fi", "sv"],
}));

const { checkMessages } = await import("./check.ts");

const reviewed: Messages[string] = {
  en: "Save",
  description: "A button.",
  fi: "Tallenna",
  sv: "Spara",
  reviewed: { fi: reviewHash("Save", "Tallenna"), sv: reviewHash("Save", "Spara") },
};

describe("a release once Swedish is released", () => {
  it("passes text reviewed in both languages", () => {
    expect(checkMessages({ "demo.save": reviewed }, { release: true }).errors).toEqual([]);
  });

  it("fails on a missing Swedish text, where before it only warned", () => {
    const { sv: _, ...withoutSv } = reviewed;
    const noSv = { ...withoutSv, reviewed: { fi: reviewHash("Save", "Tallenna") } };
    expect(checkMessages({ "demo.save": noSv }, { release: true })).toEqual({
      errors: ["demo.save: no sv text, and sv is a released language"],
      warnings: [],
    });
    expect(checkMessages({ "demo.save": noSv }, { release: false })).toEqual({
      errors: [],
      warnings: ["demo.save: no sv text"],
    });
  });

  it("fails on machine Swedish, like machine Finnish", () => {
    const machine = { ...reviewed, reviewed: { fi: reviewed.reviewed?.fi }, machine: { sv: true } };
    expect(checkMessages({ "demo.save": machine }, { release: true }).errors).toEqual([
      "demo.save: sv is still machine-translated; a release needs a native review",
    ]);
  });
});
