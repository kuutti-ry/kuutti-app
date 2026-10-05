import { PHOTOS_FOR_COMPLETENESS, PHOTOS_SUGGESTED, type TipKind } from "@kuutti/schema";

/**
 * Advisory tips for the profile owner (#56). Pure: callers gather the
 * snapshot. One tip at a time, highest priority first. Never changes
 * completeness, moderation, or matching eligibility.
 *
 * A tip is advice on top of a rule that already holds, and what completeness
 * asks for is not said twice: too few photos to be complete is
 * `completeness.missing`, and only a profile with enough of them is told that
 * one more would help.
 */
export type TipSnapshot = {
  approvedPhotos: number;
};

export function tipFor(snapshot: TipSnapshot): TipKind | null {
  const enoughPhotos = snapshot.approvedPhotos >= PHOTOS_FOR_COMPLETENESS;
  if (enoughPhotos && snapshot.approvedPhotos < PHOTOS_SUGGESTED) return "few_photos";
  return null;
}
