import { index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { account } from "./identity.ts";

/**
 * The person's requests for a copy of their data (#237, ADR-007 §3): one row
 * per export answered, written in the statement that counts the day's rows
 * against matching_config exports_per_day, so two requests cannot both pass
 * a separate count. The rows are the person's own trail: the export lists
 * them, and erasure deletes them with the account.
 */
export const accountExport = pgTable(
  "account_export",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The day's count is per account; the same index lists the history newest first.
  (table) => [index("account_export_account_at_idx").on(table.accountId, table.at)],
);
