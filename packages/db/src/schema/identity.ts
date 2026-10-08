import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { ponds } from "./ponds.ts";

/** Self-declared, one of a closed list (#46, rule 3); mirrors GENDERS in packages/schema (a test keeps them equal). */
export const gender = pgEnum("gender", ["woman", "man", "non_binary"]);

/**
 * The person and the account are two rows (TD-1, TD-7, rules/db.md). The
 * identity is what a bank login proves and what a sanction binds to: a ban set
 * here survives the deletion of every account, and a new login after a ban
 * finds it. The account is what the product sees, and what erasure removes.
 * Neither row carries the personal identity code, the legal sex, a date of
 * birth or a name from the bank (rules 1 and 3, check:schema-words).
 */
export const identityStanding = pgEnum("identity_standing", ["ok", "suspended", "banned"]);

export const identity = pgTable(
  "identity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // HMAC-SHA256 of the personal identity code with the key from SSM, hex (rule 2).
    hetuHmac: text("hetu_hmac").notNull().unique(),
    standing: identityStanding("standing").notNull().default("ok"),
    standingChangedAt: timestamp("standing_changed_at", { withTimezone: true }),
    // The registration event as the broker reported it (docs/vendors/telia.md):
    // the broker's subject, its session index, the token id, when the person
    // authenticated and how strongly. Kept for a police request that names one
    // of them; never the claims themselves.
    brokerSubject: text("broker_subject"),
    brokerSessionIndex: text("broker_session_index"),
    brokerTokenId: text("broker_token_id"),
    authenticatedAt: timestamp("authenticated_at", { withTimezone: true }),
    acr: text("acr"),
    amr: text("amr").array(),
    // Erasure (TD-7, #51): the account row becomes an anonymised tombstone
    // (state deleted), this row stays and counts.
    deletionCount: integer("deletion_count").notNull().default(0),
    // No new account before this instant after a self-deletion (TD-7 cooldown).
    reregisterAfter: timestamp("reregister_after", { withTimezone: true }),
    // Logins refused because of standing or cooldown (rules/api.md).
    refusedAttempts: integer("refused_attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("identity_standing_idx").on(table.standing)],
);

export const accountState = pgEnum("account_state", [
  "registered",
  "active",
  "paused",
  "shadow_banned",
  "suspended",
  "banned",
  "deleted",
]);

export const account = pgTable(
  "account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identity.id),
    state: accountState("state").notNull().default("registered"),
    stateChangedAt: timestamp("state_changed_at", { withTimezone: true }),
    // Age is year and month only (rule 3), derived from the code at
    // registration; nulled at erasure (#51), when the row stays as the
    // anonymised tombstone of a deleted account.
    birthYear: smallint("birth_year"),
    birthMonth: smallint("birth_month"),
    // Onboarding (#46): self-declared gender and the pond matching happens
    // in; null until answered, nulled again at erasure with the age.
    gender: gender("gender"),
    pondId: uuid("pond_id").references(() => ponds.id),
    // When the gender, or whom one seeks, last changed from an earlier
    // answer (#147, ADR-015 §9): a change is possible once in
    // matching_config.change_cadence_days. Null until the first change; on
    // the account rather than the preference row, which a withdrawn consent
    // deletes (ADR-019 §4).
    genderChangedAt: timestamp("gender_changed_at", { withTimezone: true }),
    seeksChangedAt: timestamp("seeks_changed_at", { withTimezone: true }),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // At most one live account per identity, enforced by the database, not by
    // the code that happens to check (rules/db.md).
    uniqueIndex("account_one_live_per_identity_idx")
      .on(table.identityId)
      .where(sql`${table.state} <> 'deleted'`),
    index("account_state_idx").on(table.state),
  ],
);

export type Identity = typeof identity.$inferSelect;
export type NewIdentity = typeof identity.$inferInsert;
export type IdentityStanding = Identity["standing"];
export type Account = typeof account.$inferSelect;
export type NewAccount = typeof account.$inferInsert;
export type AccountState = Account["state"];
