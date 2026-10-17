import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { account, identity } from "./identity.ts";

/**
 * One row per login attempt (#33): the state and nonce the API generated for
 * the broker, the platform to send the person back to, and, once the bank
 * has answered, the one-time code (hashed) the app exchanges. Rows live ten
 * minutes from the start, and ten minutes from the callback once it has
 * claimed them (ADR-026 §8). What bounds the table (ADR-026 §4, §6): the sign-in doors' window
 * per client address, held in memory and never here; a ceiling of rows the
 * insert itself checks (AUTH_REQUEST_CAP), at which the expired rows and then
 * the oldest attempts the bank has not answered are deleted there and then;
 * and the nightly sweep of expired rows. Nothing in them names the person, and
 * nothing records where a request came from. An app attempt carries the
 * SHA-256 of the verifier its app holds, so that only that app can exchange
 * the code (ADR-027).
 */
export const authRequest = pgTable(
  "auth_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    state: text("state").notNull().unique(),
    nonce: text("nonce").notNull(),
    platform: text("platform").notNull(),
    locale: text("locale"),
    // SHA-256 (hex) of the app's verifier for this attempt, from /auth/start
    // (ADR-027). NULL on a staff attempt, which the app's exchange can never spend.
    codeChallenge: text("code_challenge"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Set by the callback: sha256 of the code, its own short lifetime, and the
    // account it resolves to; used_at makes the code single-use.
    codeHash: text("code_hash").unique(),
    codeExpiresAt: timestamp("code_expires_at", { withTimezone: true }),
    codeUsedAt: timestamp("code_used_at", { withTimezone: true }),
    accountId: uuid("account_id").references(() => account.id),
    // NULL while the attempt waits on the bank; 'answered' once its callback
    // has claimed it (#324, ADR-026 §8), which spends the state and keeps the
    // eviction off the row, and so it stays when the callback is refused or
    // fails; a callback that succeeds attaches the code with what the login
    // decided instead: created, resumed or unpaused, or admin for staff.
    outcome: text("outcome"),
    // An admin login (#49, platform "admin") resolves to an identity with a
    // role, never to an account; the exchange turns it into an admin session.
    identityId: uuid("identity_id").references(() => identity.id),
  },
  (table) => [index("auth_request_expires_at_idx").on(table.expiresAt)],
);

export type AuthRequest = typeof authRequest.$inferSelect;
