import { type AnyPgColumn, boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * A pond is where matching happens: a campus, then a city, then a region.
 * parent_id exists from the first migration because widening is the escape
 * hatch for an imbalanced pond (TD-13) and retrofitting hierarchy onto live
 * data is painful. Case forms are stored because Finnish cannot build
 * "Otaniemessä" from "Otaniemi" by concatenation (TD-17).
 */
export const ponds = pgTable("ponds", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  nameNominative: text("name_nominative").notNull(),
  nameInessive: text("name_inessive").notNull(),
  parentId: uuid("parent_id").references((): AnyPgColumn => ponds.id),
  // Whether matching is open here (#500, ADR-060): an admin's switch in the
  // panel, false until one turns it on. No count, share or job ever sets it.
  matchingOpen: boolean("matching_open").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
