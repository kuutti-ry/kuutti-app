import { describe, expect, it } from "vitest";
import { type TipPhoto, type TipThresholds, tips } from "./tips.ts";

/** Seed / migrations 0028 and 0029 defaults. */
const thresholds: TipThresholds = {
  mirrorConfidenceMin: 50,
  bathroomConfidenceMin: 50,
  sunglassesConfidenceMin: 50,
  tightCropFaceAreaMin: 0.4,
  brightnessBelow: 40,
  sharpnessBelow: 20,
  groupPhotoMinFaces: 2,
  photosSuggested: 3,
};

const label = (name: string, confidence: number) => ({ name, confidence });

const photo = (labels: TipPhoto["labels"] = [], faces = 1): TipPhoto => ({
  labels,
  faces,
});

const snapshot = (photos: TipPhoto[], inReview = 0) => ({ photos, inReview, thresholds });

describe("the tips rule", () => {
  it.each([
    // Below what completeness asks for, `missing` says it; a tip would say it twice.
    ["no photos", [], []],
    ["one photo, no signals", [photo()], []],
    ["two photos, enough to be complete", [photo(), photo()], ["few_photos"]],
    ["three photos, no signals", [photo(), photo(), photo()], []],
  ] as const)("%s", (_name, photos, expected) => {
    expect(tips(snapshot([...photos]))).toEqual([...expected]);
  });

  it("does not ask for more photos while one is in review", () => {
    expect(tips(snapshot([photo(), photo()], 1))).toEqual([]);
  });

  it("fires a label tip only when every approved photo fails that check", () => {
    const allSunglasses = [photo([label("Sunglasses", 80)]), photo([label("Sunglasses", 60)])];
    expect(tips(snapshot(allSunglasses))).toEqual(["sunglasses", "few_photos"]);

    const oneClear = [photo([label("Sunglasses", 80)]), photo()];
    expect(tips(snapshot(oneClear))).toEqual(["few_photos"]);
  });

  it("orders kinds by the fixed priority, main-sensitive first", () => {
    const bad = [
      photo(
        [
          label("Sunglasses", 90),
          label("Mirror", 70),
          label("TightCrop", 50),
          label("Brightness", 10),
          label("Sharpness", 5),
        ],
        3,
      ),
      photo(
        [
          label("Sunglasses", 55),
          label("Bathroom", 60),
          label("TightCrop", 45),
          label("Brightness", 20),
          label("Sharpness", 8),
        ],
        2,
      ),
    ];
    expect(tips(snapshot(bad))).toEqual([
      "sunglasses",
      "mirror_selfie",
      "tight_crop",
      "group_photo",
      "poor_lighting",
      "blurry",
      "few_photos",
    ]);
  });

  it.each([
    [
      "mirror_selfie from Mirror or Bathroom",
      [photo([label("Mirror", 50)]), photo([label("Bathroom", 80)])],
      ["mirror_selfie", "few_photos"],
    ],
    [
      "tight_crop uses area × 100 against the face-area threshold",
      [photo([label("TightCrop", 40)]), photo([label("TightCrop", 55)])],
      ["tight_crop", "few_photos"],
    ],
    [
      "tight_crop below the configured area does not tip",
      [photo([label("TightCrop", 39)]), photo([label("TightCrop", 39)])],
      ["few_photos"],
    ],
    [
      "group_photo from the face count",
      [photo([], 2), photo([], 4)],
      ["group_photo", "few_photos"],
    ],
    [
      "poor_lighting needs Brightness below the floor on every photo",
      [photo([label("Brightness", 39)]), photo([label("Brightness", 10)])],
      ["poor_lighting", "few_photos"],
    ],
    [
      "blurry needs Sharpness below the floor on every photo",
      [photo([label("Sharpness", 19)]), photo([label("Sharpness", 0)])],
      ["blurry", "few_photos"],
    ],
    [
      "a confidence under the tip floor does not count",
      [photo([label("Sunglasses", 49)]), photo([label("Sunglasses", 49)])],
      ["few_photos"],
    ],
  ] as const)("%s", (_name, photos, expected) => {
    expect(tips(snapshot([...photos]))).toEqual([...expected]);
  });

  it("does not invent tips when photo_review left no signals", () => {
    expect(tips(snapshot([photo(), photo(), photo()]))).toEqual([]);
  });
});
