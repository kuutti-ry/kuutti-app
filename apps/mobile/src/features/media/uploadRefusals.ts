import type { PlainMessageKey } from "@kuutti/i18n";

/**
 * The upload pipeline's refusals in the photos screen's words, for every
 * screen that uploads a picture: the photos screen and a conversation's
 * photo (#350).
 */
export const UPLOAD_REFUSALS: ReadonlyArray<readonly [string, PlainMessageKey]> = [
  ["photo_unsupported", "photos.error.photo_unsupported"],
  ["photo_invalid", "photos.error.photo_invalid"],
  ["photo_too_many_pixels", "photos.error.tooLarge"],
  ["payload_too_large", "photos.error.tooLarge"],
  ["media_busy", "photos.error.media_busy"],
  ["media_unavailable", "photos.error.media_unavailable"],
];
