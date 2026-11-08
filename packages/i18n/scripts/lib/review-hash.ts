import { createHash } from "node:crypto";
import type { Message, TextLocale } from "./schema.ts";

/**
 * The mark a native review leaves on a translation (#55, TD-17): a hash of the
 * English source and the reviewed text together, so that a later change to
 * either shows as a text nobody has reviewed. Trimmed and NFC-normalised, so an
 * invisible difference in how the same letters are encoded is not a change.
 * Sixteen hex digits: short enough to read in a diff, long enough that two
 * texts never share one by accident. It is a stale detector, not a signature:
 * it has no secret, anyone can compute a valid hash for any text, and the
 * record that a native speaker approved a text is the approval of the pull
 * request that added the hash (translation-review-guide.md), never the hash.
 */
export function reviewHash(en: string, text: string): string {
  return createHash("sha256")
    .update(`${en.trim().normalize("NFC")}\u0000${text.trim().normalize("NFC")}`)
    .digest("hex")
    .slice(0, 16);
}

/** True when `locale`'s text carries a review hash that no longer matches it and its English. */
export function isStale(message: Message, locale: TextLocale): boolean {
  const hash = message.reviewed?.[locale];
  const text = message[locale];
  return hash !== undefined && text !== undefined && hash !== reviewHash(message.en, text);
}
