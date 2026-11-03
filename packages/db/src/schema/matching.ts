import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { account } from "./identity.ts";

/**
 * Why a candidate is in a round (TD-12), the label every card carries:
 * matches every filter, liked you, seen before, there because the person
 * relaxed a filter (#99), or sent them a fish (#378). A closed list, mirrored
 * in packages/schema.
 */
export const roundReason = pgEnum("round_reason", [
  "matches_filters",
  "liked_you",
  "seen_before",
  "relaxed",
  // #378 (ADR-039): the card of somebody whose fish waits on the person, ahead of every like.
  "fish",
]);

/**
 * What a person did with a card; undecided is no value, and a card shown and
 * left undecided on an ended day reads as a skip (ADR-062 §3). A skip spends
 * nothing, starts no clock and answers no like.
 */
export const roundDecision = pgEnum("round_decision", ["like", "pass", "skip"]);

/** How far a card's person lives (ADR-061 §5); never kilometres. A closed list, mirrored in packages/schema. */
export const distanceBand = pgEnum("distance_band", ["nearby", "close", "around", "far"]);

/**
 * A round (TD-11, #96, ADR-034, ADR-062 §1): the log of one person's queue on
 * one Finnish calendar day, opened by the day's first read and filled ten
 * people at a time. One per account and day. `opened_at` is the first read that
 * found it, `completed_at` the decision after which nothing that can still be
 * shown is undecided. The night deletes rounds past a year (ADR-062 §13), and
 * erasure deletes the person's rounds, their entries with them; the account
 * itself is a tombstone and never deleted.
 */
export const rounds = pgTable(
  "rounds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    day: date("day", { mode: "string" }).notNull(),
    builtAt: timestamp("built_at", { withTimezone: true }).notNull().defaultNow(),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // The highest place the round ever gave (#99, ADR-042 §5): a place an undo or an erasure freed is never given again.
    lastPosition: smallint("last_position").notNull().default(0),
  },
  (table) => [uniqueIndex("rounds_account_day_idx").on(table.accountId, table.day)],
);

/**
 * One candidate in a round, at its place (from 1), with why they are there,
 * when the phone reported the card seen, and the person's decision, which
 * may change until the day ends (the maintainer, 19/10/2026). Seen means
 * displayed or decided: an entry queued and never displayed is nothing, and
 * goes at the owner's next day (ADR-062 §2). Addressed by its round's day and
 * its position, never by its id. Erasure deletes the entries in which a person
 * is the candidate, and the person's own go with their rounds.
 */
export const roundEntries = pgTable(
  "round_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roundId: uuid("round_id")
      .notNull()
      .references(() => rounds.id, { onDelete: "cascade" }),
    position: smallint("position").notNull(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => account.id),
    reason: roundReason("reason").notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }),
    decision: roundDecision("decision"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    // A fish (#378, ADR-039) is a like with a mark: every reader of a like reads it as one.
    fish: boolean("fish").notNull().default(false),
    // A pass with an earlier pass behind it (ADR-062 §6): the year's clock reads
    // this alone, since the first pass's entry may be pruned before the year ends.
    secondPass: boolean("second_pass").notNull().default(false),
    // The deal-breaker a relaxed card came in by, its label (#99, ADR-042 §5 and §9).
    relaxedField: text("relaxed_field"),
    // Every relaxation of the day it came in under, the tapped one first: undoing any takes it back, and a like on it waives them all (§6, §7).
    relaxedWith: text("relaxed_with").array().notNull().default(sql`'{}'::text[]`),
    // The band between the two homes when the entry was written (ADR-061 §5,
    // ADR-062 §8), read by the card's line. Null on an entry from before #514.
    distance: distanceBand("distance"),
  },
  (table) => [
    // One card per place: the read's order, the cascade, and #98's count of the day's likes.
    uniqueIndex("round_entries_round_position_idx").on(table.roundId, table.position),
    // A candidate's entries: the likes waiting on a person and the inbox stop's
    // count (ADR-062 §4), and never twice in one round (#99).
    uniqueIndex("round_entries_candidate_round_idx").on(table.candidateId, table.roundId),
    check("round_entries_position_check", sql`${table.position} >= 1`),
    check(
      "round_entries_decided_check",
      sql`(${table.decision} IS NULL) = (${table.decidedAt} IS NULL)`,
    ),
    check("round_entries_fish_check", sql`NOT ${table.fish} OR ${table.decision} = 'like'`),
    check(
      "round_entries_second_pass_check",
      sql`NOT ${table.secondPass} OR ${table.decision} = 'pass'`,
    ),
    check(
      "round_entries_relaxed_check",
      sql`(${table.reason} = 'relaxed') = (${table.relaxedField} IS NOT NULL)
          AND (${table.relaxedField} IS NULL OR ${table.relaxedField} = ANY(${table.relaxedWith}))`,
    ),
  ],
);

/**
 * How a person loosened one of their own deal-breakers for the day (#99,
 * ADR-042 §3): let through those who did not answer its field, or set it
 * aside. Never another filter.
 */
export const relaxationKind = pgEnum("relaxation_kind", ["unanswered", "aside"]);

/**
 * A deal-breaker relaxed for one day (#99, ADR-042 §3): it hangs on the day's
 * round, so tomorrow's is built from the filters as stored, and goes with it
 * (erasure, the round's retention). One per field and round; undoing it
 * deletes the row.
 */
export const roundRelaxation = pgTable(
  "round_relaxation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roundId: uuid("round_id")
      .notNull()
      .references(() => rounds.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    kind: relaxationKind("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("round_relaxation_round_field_idx").on(table.roundId, table.field)],
);
