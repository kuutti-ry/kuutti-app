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
import { account, identity } from "./identity.ts";
import { invitation } from "./rewards.ts";
import { sanction } from "./safety.ts";
import { session } from "./sessions.ts";

/**
 * What a person may be notified of (#176, ADR-032): a message, a match, a
 * moderator's decision, an announcement (#573, ADR-068 §6). Each kind can be
 * switched off; a kind the person never touched is on, so no row means on.
 * The push reads the switch (#102: the message, the match; #312 will read the
 * decision's), and an announcement's push and email read theirs. Erased with
 * the account; in the export.
 */
export const notificationKind = pgEnum("notification_kind", [
  "message",
  "match",
  "moderation",
  "announcement",
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
 * (ADR-024 §7), an invitation of the person's that counted (#107, ADR-044),
 * the invitation they used, counted (#503), or an announcement to everybody
 * (#573, ADR-068 §3). #312's decisions and M5's matches add their kinds when
 * they write one.
 */
export const noticeKind = pgEnum("notice_kind", [
  "warning",
  "invitation_counted",
  "invitation_friend",
  "announcement",
]);

/**
 * What Kuutti tells everybody (#573, ADR-068): a title and a body in English
 * and Finnish, and in Swedish or not at all, written by one admin and sent
 * once another approves it. Staff's work, not a person's: it holds the two
 * staff identities, stays when either person is erased, is exported to
 * nobody, and is kept for good once sent (the maintainer, 2026-11-07). A
 * draft deleted goes at once.
 */
export const announcement = pgTable(
  "announcement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    titleEn: text("title_en").notNull(),
    bodyEn: text("body_en").notNull(),
    titleFi: text("title_fi").notNull(),
    bodyFi: text("body_fi").notNull(),
    titleSv: text("title_sv"),
    bodySv: text("body_sv"),
    writtenBy: uuid("written_by")
      .notNull()
      .references(() => identity.id),
    writtenAt: timestamp("written_at", { withTimezone: true }).notNull().defaultNow(),
    approvedBy: uuid("approved_by").references(() => identity.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
  },
  (table) => [
    // The panel's list, newest first.
    index("announcement_written_idx").on(table.writtenAt),
    check(
      "announcement_swedish_check",
      sql`(${table.titleSv} IS NULL) = (${table.bodySv} IS NULL)`,
    ),
    check(
      "announcement_approval_check",
      sql`(${table.approvedBy} IS NULL) = (${table.approvedAt} IS NULL)`,
    ),
    // The one who wrote it never approves it (ADR-068 §2).
    check("announcement_second_admin_check", sql`${table.approvedBy} <> ${table.writtenBy}`),
  ],
);

/**
 * A notice in the app (#176, ADR-032): what must reach a person even without
 * a push, shown on the home screen until it is read. It holds no text of its
 * own: the words are the app's, from the kind and what it points at, so a
 * warning's reason is its sanction's, and a counted invitation's reward is
 * the units it earned the person. It goes with what it points at, and with
 * the account at erasure.
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
    announcementId: uuid("announcement_id").references(() => announcement.id, {
      onDelete: "cascade",
    }),
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
    // Named by the old kinds: Postgres refuses an enum value in the
    // transaction that adds it, and the migrator applies every pending
    // migration in one. "An invitation's notice, and only it, points at its
    // invitation", and "an announcement's, and only it, at its announcement"
    // (#573), the one kind that is neither of the three before it.
    check(
      "notice_invitation_check",
      sql`(${table.kind} IN ('invitation_counted', 'invitation_friend')) = (${table.invitationId} IS NOT NULL)`,
    ),
    check(
      "notice_announcement_check",
      sql`(${table.kind} NOT IN ('warning', 'invitation_counted', 'invitation_friend')) = (${table.announcementId} IS NOT NULL)`,
    ),
    // The notices of one announcement: its push and its email read them.
    index("notice_announcement_idx")
      .on(table.announcementId)
      .where(sql`${table.announcementId} IS NOT NULL`),
  ],
);

export const pushPlatform = pgEnum("push_platform", ["ios", "android"]);

/**
 * A signed-in device's Expo push token (#102, ADR-055 §2): one per session,
 * and a token belongs to one session. It goes when its session ends: a
 * revocation deletes it (the `session_revoked_push_token` trigger), a deleted session takes
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
