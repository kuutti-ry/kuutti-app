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
  // Explicit consent for special-category fields (article 9): the version of
  // the text the person accepted and when; null means none given (ADR-009).
  specialCategoryConsentVersion: text("special_category_consent_version"),
  specialCategoryConsentedAt: timestamp("special_category_consented_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
