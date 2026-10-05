import { describe, expect, it } from "vitest";
import { ageInYears } from "./card.ts";
import { type CompletenessSnapshot, completeness } from "./completeness.ts";

const ready: CompletenessSnapshot = {
  displayName: "Aino",
  bio: "x".repeat(50),
  answeredPrompts: 0,
  approvedPhotos: 3,
  seeks: "women",
  ageWindow: [25, 35],
};

describe("the completeness rule", () => {
  it.each([
    ["everything there", ready, []],
    ["no name", { ...ready, displayName: null }, ["display_name"]],
    ["one photo", { ...ready, approvedPhotos: 1 }, ["photos"]],
    ["two photos are enough", { ...ready, approvedPhotos: 2 }, []],
    [
      "a short bio and one prompt",
      { ...ready, bio: "x".repeat(49), answeredPrompts: 1 },
      ["bio_or_prompts"],
    ],
    ["no bio but two prompts", { ...ready, bio: null, answeredPrompts: 2 }, []],
    [
      "a placeholder bio counts as none",
      { ...ready, bio: null, answeredPrompts: 0 },
      ["bio_or_prompts"],
    ],
    ["onboarding not done", { ...ready, seeks: null, ageWindow: null }, ["seeks", "age_window"]],
    [
      "nothing at all",
      {
        displayName: null,
        bio: null,
        answeredPrompts: 0,
        approvedPhotos: 0,
        seeks: null,
        ageWindow: null,
      },
      ["display_name", "photos", "bio_or_prompts", "seeks", "age_window"],
    ],
  ] as const)("%s", (_name, snapshot, missing) => {
    const verdict = completeness(snapshot);
    expect(verdict.missing).toEqual(missing);
    expect(verdict.complete).toBe(missing.length === 0);
  });
});

describe("the age on the card", () => {
  it("is whole years from the bank-verified year and month, never a day", () => {
    expect(ageInYears(1990, 6, new Date("2026-05-15T00:00:00Z"))).toBe(35);
    expect(ageInYears(1990, 6, new Date("2026-06-01T00:00:00Z"))).toBe(36);
    expect(ageInYears(1990, 6, new Date("2026-12-31T23:59:59Z"))).toBe(36);
    // By the Finnish calendar: 21:30 UTC on 31 May is already 1 June in Helsinki.
    expect(ageInYears(1990, 6, new Date("2026-05-31T21:30:00Z"))).toBe(36);
    expect(ageInYears(1990, 6, new Date("2026-05-31T20:30:00Z"))).toBe(35);
  });
});
