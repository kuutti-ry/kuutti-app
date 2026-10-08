import { index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { account } from "./identity.ts";

/**
 * Proof of consent (#46, ADR-010, GDPR art. 7): one row per consent given,
 * naming the kind, the consent_version of the wording the person read and
 * the language it was shown in. Research and the special-category consent
 * are withdrawn (withdrawn_at); terms and privacy end with the account. The rows survive
 * erasure with the tombstoned account row, so the association can show what
 * was agreed and when; they are never rewritten.
 */
// special_category: the explicit consent of article 9 for whom one seeks, politics
// and religion, one wording (ADR-019 §4, #146); withdrawn like research.
export const consentKind = pgEnum("consent_kind", [
  "terms",
  "privacy",
  "research",
  "special_category",
]);

export const consent = pgTable(
  "consent",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    kind: consentKind("kind").notNull(),
    version: text("version").notNull(),
    localeShown: text("locale_shown").notNull(),
    givenAt: timestamp("given_at", { withTimezone: true }).notNull().defaultNow(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  },
  (table) => [index("consent_account_kind_idx").on(table.accountId, table.kind)],
);

export type Consent = typeof consent.$inferSelect;
export type NewConsent = typeof consent.$inferInsert;
