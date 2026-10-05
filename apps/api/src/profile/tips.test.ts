import { describe, expect, it } from "vitest";
import { tipFor } from "./tips.ts";

describe("the tips rule", () => {
  it.each([
    // Below what completeness asks for, `missing` says it; a tip would say it twice.
    ["no photos", 0, null],
    ["one photo", 1, null],
    ["two photos, enough to be complete", 2, "few_photos"],
    ["three photos", 3, null],
    ["more than three", 6, null],
  ] as const)("%s", (_name, approvedPhotos, tip) => {
    expect(tipFor({ approvedPhotos })).toBe(tip);
  });
});
