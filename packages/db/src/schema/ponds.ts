import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * A pond is where matching happens, and there is one: `suomi`, the whole
 * country (ADR-061 §8), since a person's home says where they are. It stays as
 * the row that holds the switch, and the account, the counter and the research
 * events still name it, settled so on the maintainer's word of 01/11/2026
 * (#500). No text of the app says the word; the audit log's `pond.matching` and
 * the tunable `pond_counter_k` are raw names.
 */
export const ponds = pgTable("ponds", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  nameNominative: text("name_nominative").notNull(),
  // Whether matching is open here (#500, ADR-060): an admin's switch in the
  // panel, false until one turns it on. No count, share or job ever sets it.
  matchingOpen: boolean("matching_open").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
