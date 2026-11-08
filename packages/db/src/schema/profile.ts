import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { account } from "./identity.ts";

/**
 * The profile as the person writes it (#47, TD-16, ADR-009): one row per
 * account, the whole document on every save. The closed-list fields are one
 * jsonb validated against the registry in packages/schema (adding an option
 * is no migration); the prompts are one jsonb of at most three answers. What
 * the person typed is short and passed the plain-text rule. The row goes
 * with the account's erasure (rules/db.md, ADR-007). Nothing here is from the
 * bank: the age on the card comes from the account row.
 */
export const profile = pgTable("profile", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => account.id),
  displayName: text("display_name").notNull(),
  bio: text("bio"),
  // One of the canned placeholder lines (BIO_PRESETS), when there is no bio.
  bioPreset: text("bio_preset"),
  fields: jsonb("fields").notNull().default(sql`'{}'::jsonb`),
  prompts: jsonb("prompts").notNull().default(sql`'[]'::jsonb`),
  // The fields the person keeps off their card (#515): keys of the registry,
  // never an answer. Only the card reads it; matching reads the answers as
  // they are, hidden or not.
  hiddenFields: text("hidden_fields").array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
