import { sql } from "drizzle-orm";
import { check, index, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { account } from "./identity.ts";

/**
 * The code waiting to confirm the optional e-mail (#385, ADR-043): at most one
 * per account, replaced by the next one sent and gone when it is typed right,
 * spent by its wrong attempts, or the address changes. Only the SHA-256 of
 * the code is kept, never the code; the address it was sent to is the
 * account's own column, so a code can confirm nothing else. Erasure deletes
 * the row with the account's other rows.
 */
export const emailCode = pgTable(
  "email_code",
  {
    accountId: uuid("account_id")
      .primaryKey()
      .references(() => account.id),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Wrong codes typed so far; at matching_config email_code_attempts the row goes.
    attempts: smallint("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("email_code_attempts_check", sql`${table.attempts} >= 0`)],
);

/**
 * One row per confirmation message sent (#385, ADR-043), counted against
 * matching_config email_codes_per_day per account and Finnish day in the
 * statement that writes it, under the account's lock. A counter, not a
 * history: the rows of earlier days go when the next one is written, and
 * erasure deletes the rest.
 */
export const emailSend = pgTable(
  "email_send",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("email_send_account_at_idx").on(table.accountId, table.at)],
);
