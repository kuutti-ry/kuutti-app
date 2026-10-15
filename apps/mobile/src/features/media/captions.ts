import type { PlainMessageKey } from "@kuutti/i18n";
import type { PhotoCaption } from "@kuutti/schema";

/**
 * The words of a caption (#296): a key of PHOTO_CAPTIONS names a messages.yaml
 * entry of the same name, so every viewer reads the owner's line in their own
 * language and no text of the owner's is ever stored.
 */
export const captionKey = (caption: PhotoCaption): PlainMessageKey =>
  `photos.caption.${caption}` as PlainMessageKey;
