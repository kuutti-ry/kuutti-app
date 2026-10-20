import { z } from "zod";
import { ProfileCard } from "./profile.ts";

// Today's round (#96, TD-11, TD-12, ADR-034): what one person is shown on one
// Finnish calendar day, each card with why it is there and the person's own
// decision, which may change until the day ends. No answer carries a count,
// a score, a seen time or anybody's decision about the person.

/** A round's most entries: a bound of the contract above round_size and liked-you's share (#95, #97), not a tunable. */
export const ROUND_ENTRIES_MAX = 50;

/** Why a candidate is in the round (TD-12), the label on every card. Mirrors the database's round_reason. */
export const RoundReason = z
  .enum(["matches_filters", "liked_you", "seen_before", "relaxed"])
  .meta({ id: "RoundReason" });
export type RoundReason = z.infer<typeof RoundReason>;

/**
 * How a round's places that no rule forces were ordered (#95), named on
 * `round_built` so the research can tell the rounds of one ordering from
 * another's. `count` is approach 1, the soft matches counted without weights,
 * the first cut's (the maintainer, 20/10/2026); #98's buckets add the others.
 */
export const RoundOrdering = z.enum(["count"]).meta({ id: "RoundOrdering" });
export type RoundOrdering = z.infer<typeof RoundOrdering>;

/** What the person decided about a card. Mirrors the database's round_decision. */
export const RoundDecision = z.enum(["like", "pass"]).meta({ id: "RoundDecision" });
export type RoundDecision = z.infer<typeof RoundDecision>;

const position = z.int().min(1).max(ROUND_ENTRIES_MAX);

/** One card of the round, at its place, with the person's own decision so far. */
export const RoundEntry = z
  .object({
    position,
    reason: RoundReason,
    /** Null while undecided. */
    decision: RoundDecision.nullable(),
    card: ProfileCard,
  })
  .meta({ id: "RoundEntry" });
export type RoundEntry = z.infer<typeof RoundEntry>;

/**
 * Today's round: the Finnish day it is, and its cards in order; null while
 * the person has no round for the day, which the first read builds once their
 * matching has opened (#95, ADR-035), and an empty list for a round with
 * nobody to show. A card that cannot be
 * shown now (a block, a sanction, a profile no longer complete) is left out,
 * so places may skip a number.
 */
export const RoundResponse = z
  .object({
    day: z.iso.date(),
    entries: z.array(RoundEntry).max(ROUND_ENTRIES_MAX).nullable(),
  })
  .meta({ id: "RoundResponse" });
export type RoundResponse = z.infer<typeof RoundResponse>;

/** An entry by its round's day and its place: a day that has ended answers round_expired. */
export const RoundEntryParams = z
  .object({ day: z.iso.date(), position: z.coerce.number().int().min(1).max(ROUND_ENTRIES_MAX) })
  .meta({ id: "RoundEntryParams" });

/** A like or a pass; another one the same day replaces it. */
export const RoundDecisionUpdate = z
  .object({ decision: RoundDecision })
  .strict()
  .meta({ id: "RoundDecisionUpdate" });
export type RoundDecisionUpdate = z.infer<typeof RoundDecisionUpdate>;

/** The research events' coarse time from a card seen to its decision (ADR-011 §1), never the time itself. */
export const SinceSeenBand = z
  .enum(["under_3s", "3s_10s", "10s_30s", "30s_2m", "2m_10m", "10m_plus"])
  .meta({ id: "SinceSeenBand" });
export type SinceSeenBand = z.infer<typeof SinceSeenBand>;

/** Total over every number: a clock that stepped back reads as the shortest band. */
export function sinceSeenBand(ms: number): SinceSeenBand {
  if (ms < 3_000) return "under_3s";
  if (ms < 10_000) return "3s_10s";
  if (ms < 30_000) return "10s_30s";
  if (ms < 120_000) return "30s_2m";
  if (ms < 600_000) return "2m_10m";
  return "10m_plus";
}

/** One card of a round in the person's own export (ADR-007 §4): never whom, in keys and in words. */
export const ExportedRoundEntry = z
  .object({
    position,
    reason: RoundReason,
    reasonInWords: z.string(),
    seenAt: z.iso.datetime().nullable(),
    decision: RoundDecision.nullable(),
    decisionInWords: z.string().nullable(),
    decidedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "ExportedRoundEntry" });
export type ExportedRoundEntry = z.infer<typeof ExportedRoundEntry>;

export const ExportedRound = z
  .object({
    day: z.iso.date(),
    builtAt: z.iso.datetime(),
    openedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    entries: z.array(ExportedRoundEntry).max(ROUND_ENTRIES_MAX),
  })
  .meta({ id: "ExportedRound" });
export type ExportedRound = z.infer<typeof ExportedRound>;

export const ExportedRounds = z
  .object({
    about: z.string().meta({ description: "What this part is, in the request's language." }),
    /** The person's own rounds, newest day first, at most 1000. */
    items: z.array(ExportedRound).max(1000),
  })
  .meta({ id: "ExportedRounds" });
export type ExportedRounds = z.infer<typeof ExportedRounds>;
