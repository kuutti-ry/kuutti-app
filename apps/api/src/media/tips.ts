import type { Queryable } from "@kuutti/db";
import { type FishSpecies, PHOTOS_FOR_COMPLETENESS, type TipKind } from "@kuutti/schema";
import { matchingConfigNumbers } from "../lib/matching-config.ts";
import { fishSpeciesOf, isRevealing } from "./label-groups.ts";
import { listPhotoTipInputs } from "./repo.ts";

/**
 * Advisory tips for the profile owner (#56, #253), answered on the photo list
 * (GET /photos and PUT /photos/order) since #287, next to the photos they are
 * about. `tips` and `fishSpecies` are pure over a snapshot; `photoTips`
 * gathers it: the photos, their photo_review signals, and the matching_config
 * thresholds. Every tip that applies goes on the wire, highest priority first,
 * and the app shows one at a time; never changes completeness, moderation, or
 * matching eligibility.
 *
 * A tip is advice on top of a rule that already holds. What completeness asks
 * for is not said twice: too few photos to be complete is
 * `completeness.missing`, and only a profile with enough of them, and none
 * waiting in review, is told that more would help. Label tips fire only when
 * every approved photo fails that check (collection-wide), so one good photo
 * clears the kind; the two of #253 read the main photo alone, the first one
 * others see (the first approved one by position): a lot of skin there, or a
 * fish.
 */

/** matching_config keys the tips rule reads; values live in the seed / migrations 0028 and 0029. */
const TIP_THRESHOLD_KEYS = {
  mirrorConfidenceMin: "photo_tip_mirror_confidence_min",
  bathroomConfidenceMin: "photo_tip_bathroom_confidence_min",
  sunglassesConfidenceMin: "photo_tip_sunglasses_confidence_min",
  tightCropFaceAreaMin: "photo_tip_tight_crop_face_area_min",
  brightnessBelow: "photo_tip_brightness_below",
  sharpnessBelow: "photo_tip_sharpness_below",
  groupPhotoMinFaces: "photo_tip_group_photo_min_faces",
  photosSuggested: "photo_tip_photos_suggested",
  revealingConfidenceMin: "photo_tip_revealing_confidence_min",
  fishConfidenceMin: "photo_tip_fish_confidence_min",
  fishSpeciesMin: "photo_tip_fish_species_min",
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
  /** Photos, approved or in review, below which a complete profile hears that more would help. */
  photosSuggested: number;
  /** A swimwear, underwear or partial-nudity label at or above this on the main photo (#253). */
  revealingConfidenceMin: number;
  /** A Fish or Fishing scene label at or above this on the main photo (#253). */
  fishConfidenceMin: number;
  /** A species label at or above this lets the fish tip name the fish (#253). */
  fishSpeciesMin: number;
};

export type TipPhoto = {
  labels: ReadonlyArray<{ name: string; confidence: number }>;
  faces: number;
};

export type TipSnapshot = {
  /** The approved photos, main first; only these carry signals a tip reads. */
  photos: readonly TipPhoto[];
  /** Photos uploaded and not decided yet (pending or queued). */
  inReview: number;
  thresholds: TipThresholds;
};

/**
 * Fixed priority: main-sensitive kinds first, then lighting / blur, then the
 * count tip. Change here only.
 */
const TIP_KIND_ORDER = [
  "revealing",
  "sunglasses",
  "mirror_selfie",
  "tight_crop",
  "group_photo",
  "fish",
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

/** The main photo, the first one others see, fails the check. */
const mainPhoto = (photos: readonly TipPhoto[], fails: (photo: TipPhoto) => boolean): boolean => {
  const main = photos[0];
  return main !== undefined && fails(main);
};

const FISH = new Set(["Fish", "Fishing"]);

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
  revealing: ({ photos, thresholds: t }) =>
    mainPhoto(photos, (p) =>
      p.labels.some((l) => isRevealing(l.name) && l.confidence >= t.revealingConfidenceMin),
    ),
  fish: ({ photos, thresholds: t }) =>
    mainPhoto(photos, (p) =>
      p.labels.some((l) => FISH.has(l.name) && l.confidence >= t.fishConfidenceMin),
    ),
  // A photo still in review already answers this one.
  few_photos: ({ photos, inReview, thresholds: t }) =>
    photos.length >= PHOTOS_FOR_COMPLETENESS && photos.length + inReview < t.photosSuggested,
};

/** Every tip that applies, highest priority first. */
export function tips(snapshot: TipSnapshot): TipKind[] {
  return TIP_KIND_ORDER.filter((kind) => kindApplies[kind](snapshot));
}

/**
 * The fish the fish tip names (#253): on the main photo, the species the check
 * is surest of, at or above `fishSpeciesMin`, among those of Finland and
 * nearby waters (FishSpecies); null when the fish tip does not apply, or no
 * species is sure enough.
 */
export function fishSpecies(snapshot: TipSnapshot): FishSpecies | null {
  const main = snapshot.photos[0];
  if (!main || !kindApplies.fish(snapshot)) return null;
  let best: { species: FishSpecies; confidence: number } | null = null;
  for (const label of main.labels) {
    const species = fishSpeciesOf(label.name);
    if (!species || label.confidence < snapshot.thresholds.fishSpeciesMin) continue;
    if (!best || label.confidence > best.confidence)
      best = { species, confidence: label.confidence };
  }
  return best?.species ?? null;
}

/** The tip thresholds from matching_config, in one statement; missing keys fail closed. */
async function readTipThresholds(db: Queryable): Promise<TipThresholds> {
  const fields = Object.keys(TIP_THRESHOLD_KEYS) as (keyof typeof TIP_THRESHOLD_KEYS)[];
  const values = await matchingConfigNumbers(
    db,
    fields.map((field) => TIP_THRESHOLD_KEYS[field]),
  );
  return Object.fromEntries(
    fields.map((field) => [field, values[TIP_THRESHOLD_KEYS[field]]]),
  ) as TipThresholds;
}

/** The approved photos carry the signals; the ones in review only count. */
async function tipSnapshotOf(db: Queryable, accountId: string): Promise<TipSnapshot> {
  const [uploaded, thresholds] = await Promise.all([
    listPhotoTipInputs(db, accountId),
    readTipThresholds(db),
  ]);
  const photos = uploaded.filter((photo) => photo.state === "approved");
  return { photos, inReview: uploaded.length - photos.length, thresholds };
}

/**
 * The tips that apply to an account's photos, highest priority first, with
 * the fish the fish tip names. On the photo list since #287, where the photos
 * are; the app shows one at a time.
 */
export async function photoTips(
  db: Queryable,
  accountId: string,
): Promise<{ tips: TipKind[]; fishSpecies: FishSpecies | null }> {
  const snapshot = await tipSnapshotOf(db, accountId);
  return { tips: tips(snapshot), fishSpecies: fishSpecies(snapshot) };
}
