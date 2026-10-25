import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { account } from "./identity.ts";
import { invitation } from "./rewards.ts";
import { sanction } from "./safety.ts";
import { session } from "./sessions.ts";

/**
 * What a person may be notified of (#176, ADR-032): a new round, a message,
 * a match, a moderator's decision. Each kind can be switched off; a kind the
 * person never touched is on, so no row means on. Whoever sends later reads
 * the switch (#102 the message, #95 the round, #100 the match, #312 the
 * decision). Erased with the account; in the export.
 */
export const notificationKind = pgEnum("notification_kind", [
  "round",
  "message",
  "match",
  "moderation",
]);

export const notificationPreference = pgTable(
  "notification_preference",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    kind: notificationKind("kind").notNull(),
    enabled: boolean("enabled").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("notification_preference_kind_idx").on(table.accountId, table.kind)],
);

/**
 * What a notice in the app is about (#176, ADR-032): a moderator's warning
 * (ADR-024 §7), or an invitation of the person's that counted (#107,
 * ADR-044). #312's decisions and M5's matches add their kinds when they
 * write one.
 */
export const noticeKind = pgEnum("notice_kind", ["warning", "invitation_counted"]);

/**
 * A notice in the app (#176, ADR-032): what must reach a person even without
 * a push, shown on the home screen until it is read. It holds no text of its
 * own: the words are the app's, from the kind and what it points at, so a
 * warning's reason is its sanction's, and a counted invitation's reward is
 * the units it earned. It goes with what it points at, and with the account
 * at erasure.
 */
export const notice = pgTable(
  "notice",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    kind: noticeKind("kind").notNull(),
    sanctionId: uuid("sanction_id").references(() => sanction.id, { onDelete: "cascade" }),
    invitationId: uuid("invitation_id").references(() => invitation.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (table) => [
    // The person's notices, newest first.
    index("notice_account_created_idx").on(table.accountId, table.createdAt),
    check(
      "notice_warning_check",
      sql`(${table.kind} = 'warning') = (${table.sanctionId} IS NOT NULL)`,
    ),
    // Named by the old kind, as 0056 and 0060 do: Postgres refuses an enum
    // value in the transaction that adds it, and the migrator applies every
    // pending migration in one. With two kinds this is "a counted
    // invitation's notice, and only it, points at its invitation"; a third
    // kind rewrites it.
    check(
      "notice_invitation_check",
      sql`(${table.kind} <> 'warning') = (${table.invitationId} IS NOT NULL)`,
    ),
  ],
);

export const pushPlatform = pgEnum("push_platform", ["ios", "android"]);

/**
 * A signed-in device's Expo push token (#102, ADR-055 §2): one per session,
 * and a token belongs to one session. It goes when its session ends: a
 * revocation deletes it (migration 0082's trigger), a deleted session takes
 * it by the cascade, and erasure deletes the account's. `locale` is the
 * language the phone registered in, which its pushes are worded in. The token
 * names an installation of the app to Expo, Apple and Google, nothing about
 * the person, and is kept only to send; the export says a session has one,
 * never the token.
 */
export const pushToken = pgTable(
  "push_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    sessionId: uuid("session_id")
      .notNull()
      .unique()
      .references(() => session.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    platform: pushPlatform("platform").notNull(),
    locale: text("locale").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("push_token_account_idx").on(table.accountId)],
);
