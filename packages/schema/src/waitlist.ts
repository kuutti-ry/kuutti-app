import { z } from "zod";
import { PondSummary } from "./onboarding.ts";

/**
 * The waitlist counter (#54, ADR-013): per pond, how many bank-verified people
 * wait there, how they split by self-declared gender, and how many are still
 * finishing their profile. Public, so it is coarse on purpose, in two ways:
 * - a number is published only where at least k people stand behind it
 *   (`publishCounts`; rules/schema.md: gender counts are suppressed below k);
 * - the published numbers of a pond move only once at least k people have
 *   come or gone since they were last said (`moveFigures`), so one person
 *   coming or going changes nothing that is said. What this does not stop is
 *   in ADR-013, "What stays possible".
 */

/**
 * The floor of k (rules/schema.md). `matching_config.waitlist_k` may raise the
 * threshold, never lower it: the floor is a rule, not a tunable, so no
 * configuration row can make the counter publish a cell of one.
 */
export const WAITLIST_K_MIN = 10;

/**
 * The threshold in force: the configured one, never below the floor. A
 * fraction is rounded up, the side that says less: 12.5 means 13, not 10.
 */
export function waitlistK(configured: number): number {
  if (!Number.isFinite(configured)) return WAITLIST_K_MIN;
  return Math.max(WAITLIST_K_MIN, Math.ceil(configured));
}

/**
 * The finished profiles by whom they seek (#507): men and not women, both, and
 * women and not men. Non-binary in the seek set moves no band, and somebody who
 * seeks neither women nor men stands in none.
 */
export type SeeksBands = {
  seeksMen: number;
  seeksEveryone: number;
  seeksWomen: number;
};

/** The exact counts of one pond: internal, never served as they are. */
export type WaitlistCounts = SeeksBands & {
  /** Everyone who counts: a live account with this pond. */
  verified: number;
  woman: number;
  man: number;
  nonBinary: number;
  /** The part of `verified` whose profile is not complete yet (#47). */
  finishing: number;
};

export const WaitlistSplit = z
  .object({
    woman: z.int().min(WAITLIST_K_MIN),
    man: z.int().min(WAITLIST_K_MIN),
    nonBinary: z.int().min(WAITLIST_K_MIN),
  })
  .strict()
  .meta({ id: "WaitlistSplit" });
export type WaitlistSplit = z.infer<typeof WaitlistSplit>;

export const WaitlistPond = z
  .object({
    pond: PondSummary,
    /** The Finnish calendar day the pond's numbers last moved; null when none is published. */
    day: z.iso.date().nullable(),
    /** Null below k: the pond is listed, its size is not said. */
    verified: z.int().min(WAITLIST_K_MIN).nullable(),
    /** Null unless every cell is at least k and nobody's undeclared gender is a small remainder. */
    split: WaitlistSplit.nullable(),
    /**
     * Null when it, or the rest of the pond, is between one and k-1: so none,
     * or at least the floor. One integer with a rule, not a union: the OpenAPI
     * generator writes a union's null branch as a schema that accepts anything,
     * and the generated client type becomes `unknown`. The `not` says the
     * same rule to a reader of the OpenAPI document.
     */
    finishing: z
      .int()
      .min(0)
      .refine((n) => n === 0 || n >= WAITLIST_K_MIN, {
        error: "the number finishing is none or at least the floor",
      })
      .meta({ not: { type: "integer", minimum: 1, maximum: WAITLIST_K_MIN - 1 } })
      .nullable(),
  })
  .strict()
  .meta({ id: "WaitlistPond" });
export type WaitlistPond = z.infer<typeof WaitlistPond>;

export const WaitlistResponse = z
  .object({
    /** The threshold in force, so a reader knows what a missing number means. */
    k: z.int().min(WAITLIST_K_MIN),
    ponds: z.array(WaitlistPond).max(500),
  })
  .strict()
  .meta({ id: "WaitlistResponse" });
export type WaitlistResponse = z.infer<typeof WaitlistResponse>;

/**
 * A band's share of the three together, in whole percent. Never 0: a band said
 * here holds at least k people, and 0 % would say it holds nobody.
 */
const BandShare = z.int().min(1).max(100);

export const PondSeeks = z
  .object({ men: BandShare, everyone: BandShare, women: BandShare })
  .strict()
  .meta({ id: "PondSeeks" });
export type PondSeeks = z.infer<typeof PondSeeks>;

export const PondSeeksResponse = z
  .object({
    /** Null without a pond, and until every band of the pond is at least k. */
    seeks: PondSeeks.nullable(),
  })
  .strict()
  .meta({ id: "PondSeeksResponse" });
export type PondSeeksResponse = z.infer<typeof PondSeeksResponse>;

export type PublishedCounts = Pick<WaitlistPond, "verified" | "split" | "finishing">;

const NOTHING: PublishedCounts = { verified: null, split: null, finishing: null };

const noneOrMany = (n: number, k: number) => n === 0 || n >= k;

/**
 * What of a pond's counts may be said in public. Pure, and the only place the
 * rule lives:
 * - below k verified people, nothing: not the total, not a part of it;
 * - the split only when every one of its cells is at least k. A zero is not
 *   published either: "no men here" says of every member what they did not
 *   declare, and a pond of one gender says what each of them did;
 * - and only when the people who have declared no gender are none or at
 *   least k, since total minus the three cells is a fourth cell;
 * - `finishing` only when it and the rest of the pond are each none or at
 *   least k. It is no declaration, so a zero may be said.
 * A k below the floor and counts that cannot be (negative, a part larger than
 * the whole) publish nothing: a broken row or a broken configuration fails
 * closed.
 */
export function publishCounts(counts: WaitlistCounts | null, k: number): PublishedCounts {
  if (!counts || !Number.isInteger(k) || k < WAITLIST_K_MIN) return NOTHING;
  const cells = [counts.woman, counts.man, counts.nonBinary];
  const all = [counts.verified, counts.finishing, ...cells];
  if (all.some((n) => !Number.isInteger(n) || n < 0)) return NOTHING;
  if (counts.finishing > counts.verified) return NOTHING;
  const undeclared = counts.verified - cells.reduce((sum, n) => sum + n, 0);
  if (undeclared < 0) return NOTHING;
  if (counts.verified < k) return NOTHING;
  const splitSafe = cells.every((n) => n >= k) && noneOrMany(undeclared, k);
  const finishingSafe =
    noneOrMany(counts.finishing, k) && noneOrMany(counts.verified - counts.finishing, k);
  return {
    verified: counts.verified,
    split: splitSafe ? { woman: counts.woman, man: counts.man, nonBinary: counts.nonBinary } : null,
    finishing: finishingSafe ? counts.finishing : null,
  };
}

/**
 * What may be said of a pond's bands (#507, ADR-013 §12): whole percentages of
 * the three together, or nothing. Pure, and the only place the rule lives. A
 * band below k is not said and then neither are the others, since two shares
 * give the third, so a bar is whole or absent. No count leaves here, so nothing
 * can be subtracted from one: that is why the people in no band need no rule of
 * their own, as the undeclared do in `publishCounts`. A k below the floor and
 * bands that cannot be say nothing.
 */
export function seeksShares(bands: SeeksBands | null, k: number): PondSeeks | null {
  if (!bands || !Number.isInteger(k) || k < WAITLIST_K_MIN) return null;
  const { seeksMen, seeksEveryone, seeksWomen } = bands;
  const cells = [seeksMen, seeksEveryone, seeksWomen];
  if (cells.some((n) => !Number.isInteger(n) || n < k)) return null;
  const all = cells.reduce((sum, n) => sum + n, 0);
  const share = (n: number) => Math.max(1, Math.round((n / all) * 100));
  return { men: share(seeksMen), everyone: share(seeksEveryone), women: share(seeksWomen) };
}

const sameCounts = (a: WaitlistCounts, b: WaitlistCounts) =>
  a.verified === b.verified &&
  a.woman === b.woman &&
  a.man === b.man &&
  a.nonBinary === b.nonBinary &&
  a.finishing === b.finishing &&
  a.seeksMen === b.seeksMen &&
  a.seeksEveryone === b.seeksEveryone &&
  a.seeksWomen === b.seeksWomen;

const inBands = (c: SeeksBands) => c.seeksMen + c.seeksEveryone + c.seeksWomen;

/**
 * The counts the counter stands on after today's count: `standing` itself
 * (the same object) when nothing moves. Pure. Suppression alone does not stop
 * differencing: a total that goes from 25 to 26 with the women from 13 to 14
 * says what the one person who came that day declared. So a pond's figures
 * move in steps:
 * - figures below the floor cannot have been said under any k, so today's
 *   replace them at once. The floor, not tonight's k: figures that were said
 *   under k = 10 must stand while k is raised, or lowering it again would
 *   publish them anew a person or two later;
 * - every figure moves together, and only when the total has moved by at
 *   least k since they were taken: whatever the difference between the old
 *   and the new says, it says of at least k people. `finishing` has no
 *   trigger of its own: a second one next to the first would let two
 *   published states lie a day and one person apart;
 * - the bands alone move on their own sum (#507). They count finished profiles,
 *   so the total can move by k while they move by one, and that difference would
 *   say what the one person who finished seeks. A move of at least k finished
 *   profiles says of at least k people, whether or not the total moved.
 */
export function moveFigures(
  standing: WaitlistCounts | null,
  today: WaitlistCounts,
  k: number,
): WaitlistCounts {
  if (standing === null) return today;
  if (sameCounts(standing, today)) return standing;
  if (standing.verified < WAITLIST_K_MIN) return today;
  const step = Math.max(k, WAITLIST_K_MIN);
  const total = Math.abs(today.verified - standing.verified) >= step;
  const bands = Math.abs(inBands(today) - inBands(standing)) >= step;
  if (!total && !bands) return standing;
  const { seeksMen, seeksEveryone, seeksWomen } = bands ? today : standing;
  return { ...(total ? today : standing), seeksMen, seeksEveryone, seeksWomen };
}
