import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Every tunable of the matching mechanics is a row here, never a constant in
 * code (design principles). Versioned so the research partner can vary a knob
 * and the change is a row with a date and an author, not a deploy.
 */
export const matchingConfig = pgTable(
  "matching_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    version: integer("version").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [uniqueIndex("matching_config_key_version_idx").on(table.key, table.version)],
);
