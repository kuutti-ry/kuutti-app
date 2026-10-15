import { index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { account, identity } from "./identity.ts";

/**
 * Feedback a person sent from inside the app (#171, ADR-023): a kind, their
 * words, and what the app read for the moderators, its version, the platform
 * and the language. The text reaches no log line and no event (rule 5). At
 * most matching_config feedback_per_day rows per account and Finnish day,
 * counted in the statement that writes the row. `handled_at` and
 * `handled_by` are a moderator's reading, which is an audit_log row too. The
 * rows are the person's: the export lists them, and erasure deletes them
 * with the account. No retention clock of their own.
 */
export const feedbackKind = pgEnum("feedback_kind", ["bug", "idea", "complaint", "praise"]);
export const feedbackPlatform = pgEnum("feedback_platform", ["ios", "android", "web"]);

export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    kind: feedbackKind("kind").notNull(),
    text: text("text").notNull(),
    appVersion: text("app_version").notNull(),
    platform: feedbackPlatform("platform").notNull(),
    locale: text("locale").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    handledAt: timestamp("handled_at", { withTimezone: true }),
    handledBy: uuid("handled_by").references(() => identity.id),
  },
  (table) => [
    // The day's count is per account; the same index lists the person's rows for the export.
    index("feedback_account_created_idx").on(table.accountId, table.createdAt),
    // The panel reads what waits, oldest first within a kind.
    index("feedback_handled_created_idx").on(table.handledAt, table.createdAt),
  ],
);
