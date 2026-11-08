import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { account } from "./identity.ts";

/**
 * One row per signed-in device (#35, TD-1): the access token and the refresh
 * token are random values the API hands out once and keeps only as SHA-256
 * hashes. A refresh rotates both. The refresh token carries the session's own
 * secret, fixed for its life, whose hash is `family_hash`, so any retired
 * refresh token of the session is recognised when it comes back and revokes
 * the device (reuse detection, ADR-059). Revocation is a timestamp, so "log out everywhere"
 * is one update and the next request with any of the device's tokens fails.
 * No IP address, ever; the platform and a truncated user agent name the device
 * for the person's own list of them.
 */
export const session = pgTable(
  "session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    platform: text("platform").notNull(),
    userAgent: text("user_agent"),
    accessHash: text("access_hash").notNull().unique(),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }).notNull(),
    refreshHash: text("refresh_hash").notNull().unique(),
    familyHash: text("family_hash").notNull().unique(),
    // The refresh token's lifetime: the device must log in through the bank again after it.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
  },
  (table) => [index("session_account_idx").on(table.accountId)],
);
