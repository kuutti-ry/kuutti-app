import { describe, expect, it } from "vitest";
import { tips } from "./tips.ts";

describe("the tips rule", () => {
  it.each([
    ["no photos", 0, "fewer_photos"],
    ["two photos", 2, "fewer_photos"],
    ["three photos", 3, null],
    ["more than three", 6, null],
  ] as const)("%s", (_name, approvedPhotos, tip) => {
    expect(tips({ approvedPhotos })).toEqual({ tip });
  });
});
