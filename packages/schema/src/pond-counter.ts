import { z } from "zod";
import { PondSummary } from "./onboarding.ts";

/**
 * The pond counter (#54, #581, ADR-013): per pond, how many of the people who
 * count there have completed their profiles. Nothing here says that any other
 * profile exists. Public, so it is coarse on purpose, in two ways:
 * - the number is published only where at least k people stand behind it
 *   (`publishCounts`);
 * - the published number of a pond moves only once at least k people have
 *   come or gone since it was last said (`moveFigures`), so one person
 *   coming or going changes nothing that is said. What this does not stop is
 *   in ADR-013, "What stays possible".
 */

/**
 * The floor of k (rules/schema.md). `matching_config.pond_counter_k` may raise the
 * threshold, never lower it: the floor is a rule, not a tunable, so no
 * configuration row can make the counter publish a number of one.
 */
export const POND_COUNTER_K_MIN = 10;

/**
 * The threshold in force: the configured one, never below the floor. A
 * fraction is rounded up, the side that says less: 12.5 means 13, not 10.
 */
export function pondCounterK(configured: number): number {
  if (!Number.isFinite(configured)) return POND_COUNTER_K_MIN;
  return Math.max(POND_COUNTER_K_MIN, Math.ceil(configured));
}

/**
 * A count about one person's pool as they are told it, in the threshold's
 * steps and rounded down, the side that says less: a figure that moved by one
 * would answer what a person asks of it about one other person. The short
 * round's offers say how much a relaxation widens the pool this way (ADR-042 §4).
 */
export function saidInStep(count: number, step: number): number {
  return Math.floor(count / step) * step;
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

/** The band of whom somebody seeks; null when they seek neither women nor men. */
export function seeksBand(seeks: readonly string[] | null): keyof SeeksBands | null {
  const women = seeks?.includes("woman");
  const men = seeks?.includes("man");
  if (women && men) return "seeksEveryone";
  if (women) return "seeksWomen";
  return men ? "seeksMen" : null;
}

/** The exact counts of one pond: internal, never served as they are. */
export type PondCounterCounts = SeeksBands & {
  /** The people who count (ADR-013 §2) with an active account and a complete profile (#47). */
  finished: number;
};

/**
 * The step of a band's share (#507, ADR-013 §13). A rule, not a tunable: near k
 * a share in whole percent is a count in disguise (38, 31 and 31 can only be 12,
 * 10 and 10), and the finished profiles minus it are the people in no band.
 */
export const SEEKS_SHARE_STEP = 5;

/**
 * A band's share of the three together. Never 0: a band said here holds at
 * least k people, and 0 % would say it holds nobody.
 */
const BandShare = z.int().min(SEEKS_SHARE_STEP).max(100).multipleOf(SEEKS_SHARE_STEP);

export const PondSeeks = z
  .object({ men: BandShare, everyone: BandShare, women: BandShare })
  .strict()
  .meta({ id: "PondSeeks" });
export type PondSeeks = z.infer<typeof PondSeeks>;

export const PondCounterPond = z
  .object({
    pond: PondSummary,
    /** The Finnish calendar day the pond's number last moved; null when none is published. */
    day: z.iso.date().nullable(),
    /** The finished profiles. Null below k: the pond is listed, its size is not said. */
    finished: z.int().min(POND_COUNTER_K_MIN).nullable(),
    /**
     * Whom the pond's people seek, said to them alone: null but for the pond
     * of the session that asks, and there until every band is at least k
     * (ADR-013 §13, §18).
     */
    seeks: PondSeeks.nullable(),
  })
  .strict()
  .meta({ id: "PondCounterPond" });
export type PondCounterPond = z.infer<typeof PondCounterPond>;

export const PondCounterResponse = z
  .object({
    /** The threshold in force, so a reader knows what a missing number means. */
    k: z.int().min(POND_COUNTER_K_MIN),
    ponds: z.array(PondCounterPond).max(500),
  })
  .strict()
  .meta({ id: "PondCounterResponse" });
export type PondCounterResponse = z.infer<typeof PondCounterResponse>;

/**
 * What of a pond's counts may be said in public: its finished profiles, or null
 * below k. Pure, and the only place the rule lives. A k below the floor and a
 * count that cannot be (negative, not whole) publish nothing: a broken row or a
 * broken configuration fails closed.
 */
export function publishCounts(counts: PondCounterCounts | null, k: number): number | null {
  if (!counts || !Number.isInteger(k) || k < POND_COUNTER_K_MIN) return null;
  return Number.isInteger(counts.finished) && counts.finished >= k ? counts.finished : null;
}

/**
 * What may be said of a pond's bands (#507, ADR-013 §13): their shares of the
 * three together, in steps of `SEEKS_SHARE_STEP`, adding up to 100, or nothing.
 * Pure, and the only place the rule lives. A band below k is not said and then
 * neither are the others, since two shares give the third, so a bar is whole or
 * absent. The step is what keeps the shares from pinning the bands' sum: the
 * finished profiles minus that sum are the people in no band, who have no cell
 * of their own here. A k below the floor and bands that cannot be say nothing.
 */
export function seeksShares(bands: SeeksBands | null, k: number): PondSeeks | null {
  if (!bands || !Number.isInteger(k) || k < POND_COUNTER_K_MIN) return null;
  const { seeksMen, seeksEveryone, seeksWomen } = bands;
  const cells = [seeksMen, seeksEveryone, seeksWomen];
  if (cells.some((n) => !Number.isInteger(n) || n < k)) return null;
  const all = cells.reduce((sum, n) => sum + n, 0);
  const share = (n: number) =>
    Math.max(SEEKS_SHARE_STEP, Math.round((n * 100) / all / SEEKS_SHARE_STEP) * SEEKS_SHARE_STEP);
  const men = share(seeksMen);
  const everyone = share(seeksEveryone);
  const women = share(seeksWomen);
  // The largest band takes what the others leave. It is at least a third, so it stays a share.
  const largest = Math.max(...cells);
  if (seeksEveryone === largest) return { men, everyone: 100 - men - women, women };
  if (seeksMen === largest) return { men: 100 - everyone - women, everyone, women };
  return { men, everyone, women: 100 - men - everyone };
}

const sameCounts = (a: PondCounterCounts, b: PondCounterCounts) =>
  a.finished === b.finished &&
  a.seeksMen === b.seeksMen &&
  a.seeksEveryone === b.seeksEveryone &&
  a.seeksWomen === b.seeksWomen;

/**
 * How many people a difference between two sets of bands speaks of, at least:
 * each person adds at most one to what rose and one to what fell, so people
 * changing band count as well as people coming or going.
 */
function peopleBehind(a: SeeksBands, b: SeeksBands): number {
  const moves = [
    b.seeksMen - a.seeksMen,
    b.seeksEveryone - a.seeksEveryone,
    b.seeksWomen - a.seeksWomen,
  ];
  const sum = (ns: number[]) => ns.reduce((total, n) => total + n, 0);
  return Math.max(sum(moves.filter((n) => n > 0)), -sum(moves.filter((n) => n < 0)));
}

/**
 * The counts the counter stands on after today's count: `standing` itself
 * (the same object) when nothing moves. Pure. Suppression alone does not stop
 * differencing: a number that goes from 25 to 26 says that one person finished
 * their profile that day. So a pond's figures move in steps:
 * - figures below the floor cannot have been said under any k, so today's
 *   replace them at once. The floor, not tonight's k: figures that were said
 *   under k = 10 must stand while k is raised, or lowering it again would
 *   publish them anew a person or two later;
 * - the number moves only when it has moved by at least k since it was taken:
 *   whatever the difference between the old and the new says, it says of at
 *   least k people;
 * - the bands move on their own (#507). The people who count in the number may
 *   stand in no band, so it can move by k while the bands move by one, and that
 *   difference would say what the one person who finished seeks. They move once
 *   at least k people have come, gone or changed band, whether or not the
 *   number moved.
 */
export function moveFigures(
  standing: PondCounterCounts | null,
  today: PondCounterCounts,
  k: number,
): PondCounterCounts {
  if (standing === null) return today;
  if (sameCounts(standing, today)) return standing;
  if (standing.finished < POND_COUNTER_K_MIN) return today;
  const step = Math.max(k, POND_COUNTER_K_MIN);
  const figure = Math.abs(today.finished - standing.finished) >= step;
  const bands = peopleBehind(standing, today) >= step;
  if (!figure && !bands) return standing;
  const { finished } = figure ? today : standing;
  const { seeksMen, seeksEveryone, seeksWomen } = bands ? today : standing;
  return { finished, seeksMen, seeksEveryone, seeksWomen };
}
