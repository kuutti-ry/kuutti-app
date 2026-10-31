import { sql } from "drizzle-orm";
import {
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
import { roundEntries } from "./matching.ts";

/**
 * An invitation (#107, ADR-044): a code a person whose profile is complete
 * gives a friend, who types it after their bank login. Only the
 * SHA-256 of the normalised code is kept: the code is shown once, in the
 * answer that made it, and is in no row, log or export. Single use: once
 * redeemed it names its redeemer, and the night's count sets `counted_at` the
 * first night the redeemer is complete, when the inviter earns the reward.
 *
 * Erasure (ADR-007, ADR-044 §10): an erased inviter's open invitations go,
 * and their reward rows and notices with the account; the redeemed ones stay
 * for their redeemers with the link cut (`inviter_account_id` null), so a
 * redeemer has still redeemed one, ever, and their export still says when.
 * An erased redeemer's uncounted invitation goes; a counted one keeps its
 * count without the person (`redeemed_by_account_id` null), and the inviter
 * keeps what it earned. A row that would name nobody goes.
 */
export const invitation = pgTable(
  "invitation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Null once the inviter is erased: a redeemed invitation stays for its redeemer, the link cut.
    inviterAccountId: uuid("inviter_account_id").references(() => account.id),
    codeHash: text("code_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    redeemedByAccountId: uuid("redeemed_by_account_id").references(() => account.id),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    countedAt: timestamp("counted_at", { withTimezone: true }),
  },
  (table) => [
    // The redeem's lookup, and no two invitations with one code.
    uniqueIndex("invitation_code_hash_idx").on(table.codeHash),
    // The person's invitations, newest first: the list, the open ones' cap and erasure.
    index("invitation_inviter_created_idx").on(table.inviterAccountId, table.createdAt),
    // A person redeems one invitation, ever; erasure finds the redeemer's by it.
    uniqueIndex("invitation_redeemed_by_idx").on(table.redeemedByAccountId),
    // Open: nothing set. Redeemed: when, and by whom until a counted one's
    // redeemer is erased. Counted only once redeemed.
    check(
      "invitation_redeemed_check",
      sql`(${table.redeemedAt} IS NULL AND ${table.redeemedByAccountId} IS NULL AND ${table.countedAt} IS NULL)
          OR (${table.redeemedAt} IS NOT NULL AND (${table.redeemedByAccountId} IS NOT NULL OR ${table.countedAt} IS NOT NULL))`,
    ),
    // An inviter cut to null passes, as a check passes on unknown.
    check(
      "invitation_not_self_check",
      sql`${table.redeemedByAccountId} IS NULL OR ${table.redeemedByAccountId} <> ${table.inviterAccountId}`,
    ),
    // Somebody's: an open invitation names its inviter, and one whose inviter
    // was erased stays only while it names its redeemer.
    check(
      "invitation_named_check",
      sql`${table.inviterAccountId} IS NOT NULL OR ${table.redeemedByAccountId} IS NOT NULL`,
    ),
  ],
);

/** What one unit of the reward ledger is (#107, ADR-044): a like or a fish. Mirrors RewardKind in packages/schema. */
export const rewardKind = pgEnum("reward_kind", ["like", "fish"]);

/**
 * The reward ledger's first cut (TD-15, #85, ADR-044): one row per unit a
 * person earned, today by an invitation that counted alone, in the kinds and
 * amounts of matching_config invitation_reward read that night. Never bought
 * and never transferable. A unit is spent by the decision it paid for, a like
 * or a fish past the day's or the window's budget, and given back when that
 * decision changes the same day. One spent stays spent when its round entry
 * goes later (an erased candidate, a prune): the link goes null, the time
 * stays. Erasure deletes the person's units with their invitations.
 */
export const reward = pgTable(
  "reward",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    kind: rewardKind("kind").notNull(),
    invitationId: uuid("invitation_id")
      .notNull()
      .references(() => invitation.id, { onDelete: "cascade" }),
    earnedAt: timestamp("earned_at", { withTimezone: true }).notNull().defaultNow(),
    spentAt: timestamp("spent_at", { withTimezone: true }),
    spentEntryId: uuid("spent_entry_id").references(() => roundEntries.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    // The person's units of a kind: what a decision spends, oldest first, and what is left.
    index("reward_account_kind_idx").on(table.accountId, table.kind),
    // An invitation's units: its notice's count, and the cascade.
    index("reward_invitation_idx").on(table.invitationId),
    // What an entry was paid with: the give-back, the day's counts that leave
    // paid likes and fish out, and the set null when an entry goes.
    index("reward_spent_entry_idx")
      .on(table.spentEntryId)
      .where(sql`${table.spentEntryId} IS NOT NULL`),
    check("reward_spent_check", sql`${table.spentEntryId} IS NULL OR ${table.spentAt} IS NOT NULL`),
  ],
);
