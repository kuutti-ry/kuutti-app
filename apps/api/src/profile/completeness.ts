import {
  bioOrPromptsComplete,
  type Completeness,
  type CompletenessItem,
  PHOTOS_FOR_COMPLETENESS,
} from "@kuutti/schema";

/**
 * What a profile needs before the round builder may show it (#47): a name, at
 * least two approved photos (an automatic approval requires a face, ADR-006;
 * two since #56, where a third became a tip), a bio of fifty characters, a
 * ready line in its place (#239: the maintainer, "even if empty, but
 * placeholder - show the card") or two answered prompts, and the two things
 * onboarding sets (#46), seeks and the age window. Pure: the callers gather
 * the snapshot; the tips of #56 and the round builder of M4 read the same
 * answer.
 */
export type CompletenessSnapshot = {
  displayName: string | null;
  bio: string | null;
  /** The ready line chosen instead of a bio, or null. */
  bioPreset: string | null;
  answeredPrompts: number;
  approvedPhotos: number;
  /** From #46's preferences; null until it lands, so nothing is complete before then. */
  seeks: unknown | null;
  ageWindow: unknown | null;
};

export function completeness(snapshot: CompletenessSnapshot): Completeness {
  const missing: CompletenessItem[] = [];
  if (!snapshot.displayName) missing.push("display_name");
  if (snapshot.approvedPhotos < PHOTOS_FOR_COMPLETENESS) missing.push("photos");
  if (!bioOrPromptsComplete(snapshot)) missing.push("bio_or_prompts");
  if (snapshot.seeks === null) missing.push("seeks");
  if (snapshot.ageWindow === null) missing.push("age_window");
  return { complete: missing.length === 0, missing };
}
