import { PHOTOS_FOR_COMPLETENESS, PHOTOS_SUGGESTED, type TipKind } from "@kuutti/schema";

/**
 * Advisory tips for the profile owner (#56). Pure: callers gather photos,
 * their photo_review signals, and the matching_config thresholds. One tip at
 * a time on the wire (the first of `tips()`); never changes completeness,
 * moderation, or matching eligibility.
 *
 * A tip is advice on top of a rule that already holds. What completeness asks
 * for is not said twice: too few photos to be complete is
 * `completeness.missing`, and only a profile with enough of them is told that
 * one more would help. Label tips fire only when every approved photo fails
 * that check (collection-wide), so one good photo clears the kind.
 */

/** matching_config keys the tips rule reads; values live in the seed / migration 0028. */
export const TIP_THRESHOLD_KEYS = {
  mirrorConfidenceMin: "photo_tip_mirror_confidence_min",
  bathroomConfidenceMin: "photo_tip_bathroom_confidence_min",
  sunglassesConfidenceMin: "photo_tip_sunglasses_confidence_min",
  tightCropFaceAreaMin: "photo_tip_tight_crop_face_area_min",
  brightnessBelow: "photo_tip_brightness_below",
  sharpnessBelow: "photo_tip_sharpness_below",
  groupPhotoMinFaces: "photo_tip_group_photo_min_faces",
} as const;

export type TipThresholds = {
  mirrorConfidenceMin: number;
  bathroomConfidenceMin: number;
  sunglassesConfidenceMin: number;
  /** Face area as a fraction of the frame (0–1); tip signals store area × 100. */
  tightCropFaceAreaMin: number;
  brightnessBelow: number;
  sharpnessBelow: number;
  groupPhotoMinFaces: number;
};

export type TipPhoto = {
  labels: ReadonlyArray<{ name: string; confidence: number }>;
  faces: number;
};

export type TipSnapshot = {
  photos: readonly TipPhoto[];
  thresholds: TipThresholds;
};

/**
 * Fixed priority: main-sensitive kinds first, then lighting / blur, then the
 * count tip. Change here only.
 */
export const TIP_KIND_ORDER = [
  "sunglasses",
  "mirror_selfie",
  "tight_crop",
  "group_photo",
  "poor_lighting",
  "blurry",
  "few_photos",
] as const satisfies readonly TipKind[];

const labelAtLeast = (photo: TipPhoto, name: string, min: number): boolean =>
  photo.labels.some((label) => label.name === name && label.confidence >= min);

const labelBelow = (photo: TipPhoto, name: string, max: number): boolean =>
  photo.labels.some((label) => label.name === name && label.confidence < max);

/** Every approved photo fails the check; an empty collection never tips. */
const everyPhoto = (photos: readonly TipPhoto[], fails: (photo: TipPhoto) => boolean): boolean =>
  photos.length > 0 && photos.every(fails);

/** Per-kind fail check; order comes only from TIP_KIND_ORDER. */
const kindApplies: Record<TipKind, (snapshot: TipSnapshot) => boolean> = {
  sunglasses: ({ photos, thresholds: t }) =>
    everyPhoto(photos, (p) => labelAtLeast(p, "Sunglasses", t.sunglassesConfidenceMin)),
  mirror_selfie: ({ photos, thresholds: t }) =>
    everyPhoto(
      photos,
      (p) =>
        labelAtLeast(p, "Mirror", t.mirrorConfidenceMin) ||
        labelAtLeast(p, "Bathroom", t.bathroomConfidenceMin),
    ),
  // tipLabelsFrom stores TightCrop confidence as area × 100 (moderation.ts).
  tight_crop: ({ photos, thresholds: t }) =>
    everyPhoto(photos, (p) => labelAtLeast(p, "TightCrop", t.tightCropFaceAreaMin * 100)),
  group_photo: ({ photos, thresholds: t }) =>
    everyPhoto(photos, (p) => p.faces >= t.groupPhotoMinFaces),
  poor_lighting: ({ photos, thresholds: t }) =>
    everyPhoto(photos, (p) => labelBelow(p, "Brightness", t.brightnessBelow)),
  blurry: ({ photos, thresholds: t }) =>
    everyPhoto(photos, (p) => labelBelow(p, "Sharpness", t.sharpnessBelow)),
  few_photos: ({ photos }) =>
    photos.length >= PHOTOS_FOR_COMPLETENESS && photos.length < PHOTOS_SUGGESTED,
};

export function tips(snapshot: TipSnapshot): TipKind[] {
  return TIP_KIND_ORDER.filter((kind) => kindApplies[kind](snapshot));
}

/** Highest-priority tip, or null when none applies. */
export function tipFor(snapshot: TipSnapshot): TipKind | null {
  return tips(snapshot)[0] ?? null;
}
