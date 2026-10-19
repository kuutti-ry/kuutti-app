import { PROFILE_FIELD_KEYS, PROFILE_FIELDS, type ProfileFields } from "@kuutti/schema";

/**
 * The soft preferences (#87, ADR-019 §1, the maintainer's answers of
 * 19/10/2026 on #87): ordering only, never a filter and never shown. A soft
 * preference is a person's own answer: the other person's answer is similar
 * when it is the same or the step next to it in the registry's order
 * (drinking never and rarely, AMK and kandi, and so on), and a person who
 * left the field blank prefers nothing on it. A field counts only when the
 * two are similar from both sides, so one side cannot carry it and no weight
 * is needed.
 *
 * Which fields are soft is the registry's (`preferenceAbout`), never named
 * here. The round builder (#95) orders a round's non-forced places by the
 * count, without weights; it never reaches a card, an event or a log line
 * as a number (the matching document's invariant 6).
 */
const SOFT = PROFILE_FIELD_KEYS.flatMap((key) => {
  const spec = PROFILE_FIELDS[key];
  return spec.preferenceAbout === "soft" && spec.kind === "single"
    ? [{ key, steps: spec.options as readonly unknown[] }]
    : [];
});

/** How many soft fields the two are similar on, from both sides: 0 to the number of soft fields. */
export function softMatches(a: ProfileFields, b: ProfileFields): number {
  let count = 0;
  for (const { key, steps } of SOFT) {
    const mine = steps.indexOf(a[key]);
    const theirs = steps.indexOf(b[key]);
    if (mine >= 0 && theirs >= 0 && Math.abs(mine - theirs) <= 1) count += 1;
  }
  return count;
}
