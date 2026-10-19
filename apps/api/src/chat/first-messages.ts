import type { Queryable } from "@kuutti/db";
import { openersSince } from "./repo.ts";

// The chat's measure for the automatic rules on first messages (#105,
// ADR-033): how many conversations a person opened in a window, and to how
// many people they sent the same opener. The safety slice decides; this file
// reads the words, compares them in memory and hands back counts and times
// only. Nothing derived from a message is kept: no key, hash or length, since
// a hash of a short opener is reversed with a dictionary (rule 5).

/**
 * An opener's letters, digits and the marks that belong to letters (the
 * vowel signs of Thai or Devanagari), compatibility forms and case folded:
 * spacing, punctuation, emoji and their variation selectors never make two
 * openers differ, a changed word or number always does. Spacing goes before
 * case is folded, so a Greek final sigma folds the same with or without it.
 * Folded in JavaScript, not SQL, whose classes follow the database's locale.
 * Null for an opener with no letter or digit, such as a photo with no
 * caption, which is never the same as another.
 */
export function openerKey(body: string | null): string | null {
  const key = (body ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "")
    .replace(/[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{20E3}]/gu, "")
    .toLowerCase();
  return /[\p{L}\p{N}]/u.test(key) ? key : null;
}

export type Counted = { count: number; firstAt: Date | null };

/**
 * For the opener of `conversationId`: the person's openers since
 * `firstSince`, and those since `sameSince` with the same key as it; each
 * with the earliest it counted. The opener itself is among both.
 */
export async function firstMessageCounts(
  db: Queryable,
  input: { accountId: string; conversationId: string; firstSince: Date; sameSince: Date },
): Promise<{ first: Counted; same: Counted }> {
  const since = input.firstSince < input.sameSince ? input.firstSince : input.sameSince;
  const openers = await openersSince(db, input.accountId, since);
  const own = openers.find((opener) => opener.conversationId === input.conversationId);
  const key = own ? openerKey(own.body) : null;
  const counted = (keep: (opener: (typeof openers)[number]) => boolean): Counted => {
    const kept = openers.filter(keep);
    const firstAt = kept.reduce<Date | null>(
      (earliest, opener) => (earliest === null || opener.at < earliest ? opener.at : earliest),
      null,
    );
    return { count: kept.length, firstAt };
  };
  return {
    first: counted((opener) => opener.at > input.firstSince),
    same:
      key === null
        ? { count: 0, firstAt: null }
        : counted((opener) => opener.at > input.sameSince && openerKey(opener.body) === key),
  };
}
