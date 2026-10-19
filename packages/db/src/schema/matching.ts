import { sql } from "drizzle-orm";
import {
  check,
  date,
  pgEnum,
  pgTable,
  smallint,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { account } from "./identity.ts";

/**
 * Why a candidate is in a round (TD-12), the label every card carries:
 * matches every filter, liked you, seen before, or there because the person
 * relaxed a filter (#99). A closed list, mirrored in packages/schema.
 */
export const roundReason = pgEnum("round_reason", [
  "matches_filters",
  "liked_you",
  "seen_before",
  "relaxed",
]);

/** What a person decided about a card; undecided is no value, and expired is undecided on an ended day. */
export const roundDecision = pgEnum("round_decision", ["like", "pass"]);

/**
 * A round (TD-11, #96, ADR-034): what one person is shown on one Finnish
 * calendar day, written by the round builder (#95) through `saveRound`. One
 * per account and day. `opened_at` is the first read that found it,
 * `completed_at` the decision after which nothing that can still be shown is
 * undecided. Erasure deletes the person's rounds, their entries with them;
 * the account itself is a tombstone and never deleted.
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
  },
  (table) => [uniqueIndex("rounds_account_day_idx").on(table.accountId, table.day)],
);

/**
 * One candidate in a round, at its place (from 1), with why they are there,
 * when the phone reported the card seen, and the person's decision, which
 * may change until the day ends (the maintainer, 19/10/2026). Shown means an
 * entry exists. Addressed by its round's day and its position, never by its
 * id. Erasure deletes the entries in which a person is the candidate, and the
 * person's own go with their rounds.
 */
// shortcut: kept until erasure, about 60,000 rows a day at 5,000 people; a
// prune past the longest look-back (#99) lifts it once the maintainer sets a
// retention (ADR-034).
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
  },
  (table) => [
    // One card per place: the read's order, the cascade, and #98's count of the day's likes.
    uniqueIndex("round_entries_round_position_idx").on(table.roundId, table.position),
    // The exposure index (TD-11): a candidate's entries, and never twice in one round (#99).
    // shortcut: the seven-day count walks a candidate's entries and takes the
    // day through rounds; a day on the entry lifts it if #95's count is slow.
    uniqueIndex("round_entries_candidate_round_idx").on(table.candidateId, table.roundId),
    check("round_entries_position_check", sql`${table.position} >= 1`),
    check(
      "round_entries_decided_check",
      sql`(${table.decision} IS NULL) = (${table.decidedAt} IS NULL)`,
    ),
  ],
);
