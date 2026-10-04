import { PHOTOS_FOR_COMPLETENESS, type Tips } from "@kuutti/schema";

/**
 * Advisory tips for the profile owner (#56). Pure: callers gather the
 * snapshot. One tip at a time, highest priority first. Never changes
 * completeness, moderation, or matching eligibility.
 */
export type TipsSnapshot = {
  approvedPhotos: number;
};

export function tips(snapshot: TipsSnapshot): Tips {
  if (snapshot.approvedPhotos < PHOTOS_FOR_COMPLETENESS) {
    return { tip: "fewer_photos" };
  }
  return { tip: null };
}
