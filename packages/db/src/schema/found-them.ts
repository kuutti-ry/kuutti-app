import { sql } from "drizzle-orm";
import { check, date, integer, pgEnum, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * "Löysin hänet" (#83, ADR-040): why a person told Kuutti they found
 * somebody, a closed list (the maintainer, 21/10/2026). Never free text.
 */
export const foundReason = pgEnum("found_reason", ["here", "elsewhere", "other"]);

/**
 * The association's one measure of success, counted with no person in it: how
 * many said, on each Finnish day, that they found somebody, by reason. A row
 * names no account, so it outlives every erasure, and the export of a person
 * carries nothing of it. The account keeps only that it answered
 * (account.found_them_answered), so each counts once.
 */
export const foundThemCount = pgTable(
  "found_them_count",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    day: date("day", { mode: "string" }).notNull(),
    reason: foundReason("reason").notNull(),
    count: integer("count").notNull(),
  },
  (table) => [
    // One row per day and reason, which the answer's upsert lands on.
    uniqueIndex("found_them_count_day_reason_idx").on(table.day, table.reason),
    check("found_them_count_count_check", sql`${table.count} >= 1`),
  ],
);
