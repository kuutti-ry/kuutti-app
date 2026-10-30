import { date, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { ponds } from "./ponds.ts";

/**
 * The figures the waitlist counter stands on (#54, ADR-013): one row per pond,
 * written by the nightly job and served, after suppression, by the public
 * `GET /waitlist`. The counts are exact and internal; what may be said in
 * public is decided when they are read (`publishCounts` in packages/schema),
 * so a change of k needs no rewrite. A row is replaced only when its pond has
 * moved by at least k (`moveFigures`), and `day` is the Finnish calendar day
 * that happened. `taken_at` is when the pond was last counted, moved or not:
 * the newest one marks the day that has had its count.
 *
 * One row per pond and no history, on purpose: a series of daily exact counts
 * would say, next to a tombstone's `deleted_at`, which pond and which cell
 * lost one that day, which is what erasure removed (TD-7). Aggregates only:
 * no account, no identity, nothing finer than a day.
 */
export const waitlistSnapshot = pgTable("waitlist_snapshot", {
  pondId: uuid("pond_id")
    .primaryKey()
    .references(() => ponds.id),
  day: date("day", { mode: "string" }).notNull(),
  verified: integer("verified").notNull(),
  woman: integer("woman").notNull(),
  man: integer("man").notNull(),
  nonBinary: integer("non_binary").notNull(),
  finishing: integer("finishing").notNull(),
  // Finished profiles by whom they seek (#507): moved by their own sum, read only
  // as shares. A row written before them stands at zero, which says nothing.
  seeksMen: integer("seeks_men").notNull().default(0),
  seeksEveryone: integer("seeks_everyone").notNull().default(0),
  seeksWomen: integer("seeks_women").notNull().default(0),
  takenAt: timestamp("taken_at", { withTimezone: true }).notNull().defaultNow(),
});
