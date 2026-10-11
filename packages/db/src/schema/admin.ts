import { index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { identity } from "./identity.ts";

/**
 * Staff (#49, rules/admin.md): a role on an identity row, so the allowlist is
 * by hetu_hmac through the identity table and needs no second copy of it.
 * One role per person; the role is checked server-side on every admin route.
 * Rows are written by the maintainer (packages/db moderator CLI), never by a
 * route.
 */
export const moderatorRole = pgEnum("moderator_role", ["moderator", "admin", "researcher"]);

export const moderatorRoles = pgTable("moderator_roles", {
  identityId: uuid("identity_id")
    .primaryKey()
    .references(() => identity.id),
  role: moderatorRole("role").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  // Who granted it, as a name for the audit trail; not an identity reference.
  grantedBy: text("granted_by").notNull(),
});

/**
 * A staff session (#49, rules/api.md Identity): a bank login by an identity
 * with a role, eight hours, no refresh token; the bearer token is kept as a
 * hash. Separate from the product's session table so that a product session
 * never opens an admin route and an admin token never answers as an account.
 */
export const adminSession = pgTable(
  "admin_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identity.id),
    role: moderatorRole("role").notNull(),
    accessHash: text("access_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("admin_session_identity_idx").on(table.identityId)],
);
