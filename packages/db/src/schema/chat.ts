import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { account } from "./identity.ts";
import { photo } from "./media.ts";

/**
 * The chat (#348, ADR-031): a conversation is the record of a match (#100
 * writes it from the second like; until then the demo stories and the tests
 * do), its two participants, and the messages in it. A message belongs to
 * the conversation (TD-1): nothing here is deleted when a conversation closes,
 * and erasure cuts the person's link (`account_id` null) and closes the
 * conversation, keeping the words for the counterpart (TD-7's kept side).
 * Every query a person makes goes through their own participant row (rule 6).
 */
export const conversationClose = pgEnum("conversation_close", [
  "block",
  "unmatch",
  "erasure",
  "sanction",
]);
export const conversationSide = pgEnum("conversation_side", ["a", "b"]);
/** A text, or a photo (#350) with its photo's id and the body as its caption. */
export const messageKind = pgEnum("message_kind", ["text", "photo"]);

/**
 * `next_seq` is the sequence the next message takes, assigned in the send's
 * statement under the row's lock, so the order is total and a gap would be
 * visible (ADR-031 §3). `archived_at` is set by the night after
 * `silent_match_archive_days` without a message and cleared by the next one
 * (TD-13); `closed_at`, `closed_how` and `closed_by` go together, and a
 * closed conversation takes no more messages. `closed_by` is the side whose
 * act or account closed it: the blocker for a block, so that the blocker
 * never sees the conversation again even after the other's erasure has cut
 * the link a live block test would need (ADR-030 §6, ADR-031 §2).
 */
export const conversation = pgTable(
  "conversation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    nextSeq: integer("next_seq").notNull().default(1),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedHow: conversationClose("closed_how"),
    closedBy: conversationSide("closed_by"),
  },
  (table) => [
    check(
      "conversation_closed_check",
      sql`(${table.closedAt} IS NULL) = (${table.closedHow} IS NULL)
        AND (${table.closedAt} IS NULL) = (${table.closedBy} IS NULL)`,
    ),
    check("conversation_next_seq_check", sql`${table.nextSeq} >= 1`),
  ],
);

/**
 * One row per side. `read_up_to` is the highest sequence the person has read
 * (#349 fans it out as the read receipt); it never goes down. `account_id`
 * goes null at the person's erasure and the row stays, so the counterpart
 * keeps the conversation under "Deleted user".
 */
export const conversationParticipant = pgTable(
  "conversation_participant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => account.id),
    side: conversationSide("side").notNull(),
    readUpTo: integer("read_up_to").notNull().default(0),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("conversation_participant_side_idx").on(table.conversationId, table.side),
    // Two nulls are distinct: both people of a conversation may be erased.
    uniqueIndex("conversation_participant_account_idx").on(table.conversationId, table.accountId),
    // The list: a person's conversations.
    index("conversation_participant_account_id_idx").on(table.accountId),
    check("conversation_participant_read_check", sql`${table.readUpTo} >= 0`),
  ],
);

/**
 * A message: its place in the conversation (`seq`), the side that wrote it,
 * the id the phone gave it (a resend after a lost answer is the same row),
 * and the text. Message text reaches no log line, event or push (rule 5).
 */
export const message = pgTable(
  "message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    side: conversationSide("side").notNull(),
    clientId: uuid("client_id").notNull(),
    kind: messageKind("kind").notNull(),
    body: text("body"),
    // A photo message's photo; null once the sender's erasure took it, which
    // reads "Photo removed" (#350).
    photoId: uuid("photo_id").references(() => photo.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("message_seq_idx").on(table.conversationId, table.seq),
    uniqueIndex("message_client_idx").on(table.conversationId, table.clientId),
    // One message per photo; the photo's deletion finds its message by it.
    uniqueIndex("message_photo_idx").on(table.photoId),
    check("message_text_body_check", sql`${table.kind} <> 'text' OR ${table.body} IS NOT NULL`),
    check("message_seq_check", sql`${table.seq} >= 1`),
    // Only a photo message has a photo. Written without naming the new kind:
    // the value added in this migration cannot be used in its transaction.
    check("message_photo_check", sql`${table.photoId} IS NULL OR ${table.kind} <> 'text'`),
  ],
);

/**
 * The kinds of contact a person may keep and share in a conversation (#103,
 * the maintainer's decisions of 18/10/2026 and, for Snapchat, 28/10/2026): a
 * phone number, WhatsApp (a number), Telegram, Instagram and Snapchat (a
 * username).
 */
export const contactKind = pgEnum("contact_kind", [
  "phone",
  "whatsapp",
  "telegram",
  "instagram",
  "snapchat",
]);
/** How a share ended: its owner stopped it, the stored piece was removed, or the conversation closed. */
export const contactShareEnd = pgEnum("contact_share_end", ["stopped", "removed", "closed"]);

/**
 * A person's own contacts (#103, ADR-031 §11), one per kind, normalised by
 * kind (packages/schema contact.ts). Seen by nobody until the person shares
 * one in a conversation; never in a log line, an event, or anyone else's
 * export. Erasure deletes them.
 */
export const contact = pgTable(
  "contact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    kind: contactKind("kind").notNull(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("contact_account_kind_idx").on(table.accountId, table.kind),
    check("contact_value_check", sql`length(${table.value}) BETWEEN 1 AND 64`),
  ],
);

/**
 * One stored piece shared in a conversation (#103, ADR-031 §11): a press of
 * Share, seen by the other person at once, until its owner stops it, the
 * piece is removed, or the conversation closes. The row holds no value: the
 * conversation shows the stored piece while the share stands, so what stays
 * after it ends is the record (who, in which conversation, which kind, when,
 * and how it ended) and never the contact.
 */
export const contactShare = pgTable(
  "contact_share",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    side: conversationSide("side").notNull(),
    kind: contactKind("kind").notNull(),
    sharedAt: timestamp("shared_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedHow: contactShareEnd("ended_how"),
  },
  (table) => [
    // One standing share per side and kind; an ended one may be shared again.
    uniqueIndex("contact_share_standing_idx")
      .on(table.conversationId, table.side, table.kind)
      .where(sql`${table.endedAt} IS NULL`),
    check(
      "contact_share_ended_check",
      sql`(${table.endedAt} IS NULL) = (${table.endedHow} IS NULL)`,
    ),
  ],
);
