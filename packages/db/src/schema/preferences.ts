import {
  boolean,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { account } from "./identity.ts";

/**
 * preferences(account_id, field, value, mode hard|soft, include_unknown)
 * (rules/db.md): one row per field. Deal-breakers are mode = hard rows, and
 * the pool asks both parties' hard rows (#87, ADR-015 §15). Onboarding (#46)
 * writes the two hard rows nothing can start without, `seeks` and
 * `age_window`; the deal-breakers over profile fields are hard rows too
 * (#149). Nothing writes a soft row: a soft preference is the person's own
 * answer (#87, ADR-019 §1), so `soft` is a value of the enum nothing uses.
 * The rows go with the account at erasure (TD-7).
 */
export const preferenceMode = pgEnum("preference_mode", ["hard", "soft"]);

export const preferences = pgTable(
  "preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    field: text("field").notNull(),
    value: jsonb("value").notNull(),
    mode: preferenceMode("mode").notNull(),
    // Whether a candidate who left the field unanswered passes this row.
    includeUnknown: boolean("include_unknown").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("preferences_account_field_idx").on(table.accountId, table.field)],
);
