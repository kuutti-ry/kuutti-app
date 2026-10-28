import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { conversation, messageKind } from "./chat.ts";
import { account, identity } from "./identity.ts";
import { photo } from "./media.ts";

/**
 * The audit log (TD-5, security checklist "immutable audit table", #49):
 * every moderator action and every photo a member of staff looks at, with
 * who (an identity, never an account), what, on which subject, and when.
 * Append-only: a trigger in the custom migration next to this table's one
 * refuses UPDATE, DELETE and TRUNCATE from the application role; the owner
 * could still disable the trigger, which is why a separate owner role is the
 * M4 step (ADR-006). Kept five years, survives erasure (rules/db.md).
 * `detail` is bounded structured data, never text from a person. The actor
 * is null for one thing only: a shadow ban an automatic rule applied (#105,
 * ADR-033), which no person did; a check holds every other row to a person.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorIdentityId: uuid("actor_identity_id").references(() => identity.id),
    // e.g. photo.view, photo.approve, photo.reject; a closed set in code.
    action: text("action").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    detail: jsonb("detail"),
  },
  (table) => [
    index("audit_log_subject_idx").on(table.subjectType, table.subjectId),
    index("audit_log_actor_at_idx").on(table.actorIdentityId, table.at),
    check(
      "audit_log_actor_check",
      sql`${table.actorIdentityId} IS NOT NULL OR ${table.action} = 'sanction.apply'`,
    ),
  ],
);

/**
 * A photo the automatic check did not show to others for a hard label (#253,
 * ADR-006 §2): which kind, and when; nothing of the picture. Two within the
 * window make the check stricter for that account for a while (computed,
 * never stored); the person reads them in their export in plain words, and
 * nobody else sees them. A person approving the photo on appeal removes its
 * note: the check was wrong. The photo's own deletion keeps the note, without
 * the link. Kept twelve months (a nightly prune), deleted with the account by
 * the erasure path (the tombstone keeps the account row).
 */
export const photoCheckKind = pgEnum("photo_check_kind", [
  "nudity",
  "violence",
  "disturbing",
  "hate",
]);

export const photoCheckNote = pgTable(
  "photo_check_note",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    photoId: uuid("photo_id").references(() => photo.id, { onDelete: "set null" }),
    kind: photoCheckKind("kind").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("photo_check_note_account_at_idx").on(table.accountId, table.at)],
);

/**
 * A sanction (#307, ADR-024): a warning, a shadow ban, a suspension until a
 * day, or a ban, with a reason from a closed list and staff's note. The row is
 * the record; the account's state and the identity's standing are settled
 * from the rows still open on every change, never stored here. `created_by`
 * and `lifted_by` are null for what no person did (the night's end of a
 * suspension, the demo's story, #105's rules). The note is staff's words:
 * never in a log line, an error detail, an event or the person's export.
 * Erasure deletes the account's rows except the open bans and suspensions,
 * which carry the identity's standing (TD-7's kept side); the audit log keeps
 * the history.
 */
export const sanctionKind = pgEnum("sanction_kind", ["warn", "shadow_ban", "suspend", "ban"]);
/**
 * The automatic rule that applied a shadow ban (#105, ADR-033): reports by
 * different people, first messages faster than a person writes them, the
 * same first message to many; and #86's velocity (ADR-041): other people's
 * photos fetched, cards served and the round read faster than a person does.
 */
export const sanctionRule = pgEnum("sanction_rule", [
  "reports",
  "first_messages",
  "same_first_message",
  "photo_fetches",
  "cards_served",
  "round_reads",
]);
export const sanctionReason = pgEnum("sanction_reason", [
  "harassment",
  "misrepresentation",
  "under_age",
  "commercial_use",
  "scraping",
  "other",
]);

export const sanction = pgTable(
  "sanction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identity.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    kind: sanctionKind("kind").notNull(),
    reason: sanctionReason("reason").notNull(),
    note: text("note").notNull(),
    // A suspension's end: the start of the chosen day in Finland. Only a suspension has one.
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => identity.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
    liftedBy: uuid("lifted_by").references(() => identity.id),
    reviewNote: text("review_note"),
    reviewedBy: uuid("reviewed_by").references(() => identity.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    // An automatic rule's record (#105, ADR-033): which rule, what it
    // counted, and the earliest event it counted; counts and times only,
    // never a message, a reporter or a conversation.
    rule: sanctionRule("rule"),
    ruleCount: integer("rule_count"),
    ruleFirstAt: timestamp("rule_first_at", { withTimezone: true }),
  },
  (table) => [
    // The person's page lists an account's rows, newest first.
    index("sanction_account_created_idx").on(table.accountId, table.createdAt),
    // Settling reads what is still open on an identity, a ban across its accounts.
    index("sanction_identity_open_idx").on(table.identityId).where(sql`${table.liftedAt} IS NULL`),
    check(
      "sanction_ends_at_check",
      sql`(${table.kind} = 'suspend') = (${table.endsAt} IS NOT NULL)`,
    ),
    check("sanction_note_check", sql`char_length(${table.note}) BETWEEN 1 AND 500`),
    check("sanction_lift_check", sql`${table.liftedBy} IS NULL OR ${table.liftedAt} IS NOT NULL`),
    check(
      "sanction_review_check",
      sql`(${table.reviewedAt} IS NULL AND ${table.reviewedBy} IS NULL AND ${table.reviewNote} IS NULL)
        OR (${table.reviewedAt} IS NOT NULL AND ${table.reviewedBy} IS NOT NULL
          AND ${table.reviewNote} IS NOT NULL AND char_length(${table.reviewNote}) BETWEEN 1 AND 500)`,
    ),
    // A rule's record comes whole, and only on a shadow ban by nobody: a
    // machine never warns, suspends or bans (#105).
    check(
      "sanction_rule_check",
      sql`(${table.rule} IS NULL) = (${table.ruleCount} IS NULL)
        AND (${table.rule} IS NULL) = (${table.ruleFirstAt} IS NULL)
        AND (${table.rule} IS NULL OR (${table.createdBy} IS NULL AND ${table.kind} = 'shadow_ban'
          AND ${table.ruleCount} >= 1 AND ${table.ruleFirstAt} <= ${table.createdAt}))`,
    ),
  ],
);

/**
 * A block (#84, ADR-030): one person set it from a card they were shown, and
 * from then on neither is shown to the other, in either direction, anywhere
 * a person is shown to a person (rule 7). Between the two identities, not the
 * accounts, so it holds for a later account of either; final, with no list
 * and no unblock. Nothing reads it but the filters: the pool's count
 * (`inEachOthersPool`), and `blocked_between(a, b)`, the database function of
 * migration 0051 that the card and the photo reads ask. Kept through the
 * erasure of either person, as long as the identities (TD-7's kept side);
 * the export lists the person's own blocks by date, never whom.
 */
export const block = pgTable(
  "block",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    blockerIdentityId: uuid("blocker_identity_id")
      .notNull()
      .references(() => identity.id),
    blockedIdentityId: uuid("blocked_identity_id")
      .notNull()
      .references(() => identity.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One row per pair and direction, what a second block's ON CONFLICT DO
    // NOTHING needs; both directions of `blocked_between` and the export's
    // own blocks are lookups on it.
    uniqueIndex("block_pair_idx").on(table.blockerIdentityId, table.blockedIdentityId),
    check("block_not_self_check", sql`${table.blockerIdentityId} <> ${table.blockedIdentityId}`),
  ],
);

/**
 * A report (#84, ADR-030): one person tells the moderators about another,
 * from a card they were shown, with a reason of #106's list and, if they
 * like, a few lines; it blocks both ways in the same transaction. The note
 * reaches no log line, error detail or event (rule 5). At most
 * matching_config reports_per_day per account and Finnish day, counted in the
 * statement that writes the row; one open report per pair. The decision
 * columns are #312's: dismissed, or acted on with the sanction it led to
 * (#307), by whom and when; the export says the outcome. Kept twelve months
 * from filing (a nightly prune), whoever of the two is erased in between
 * (TD-7's "report snapshots for 12 months"). `source` says where it was
 * made: a card, or a conversation (#351), whose id it keeps while the
 * conversation exists (a conversation goes once both its people are erased,
 * ADR-031 §5; the report stays its twelve months) and whose messages it
 * copies at filing into `report_message`. A report may point at the one
 * photo it is about (#476, ADR-030 §13): a conversation's at a line of its
 * copy (`line_seq`), a card's at a photo of the card the reporter was shown
 * (`photo_id`, which goes null with the photo, so it holds nothing;
 * `photo_pointed` keeps that one was named, so the moderator reads the
 * photo as removed rather than as never pointed at).
 */
export const reportSource = pgEnum("report_source", ["card", "conversation"]);
export const reportOutcome = pgEnum("report_outcome", ["dismissed", "acted"]);

export const report = pgTable(
  "report",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reporterAccountId: uuid("reporter_account_id")
      .notNull()
      .references(() => account.id),
    reportedAccountId: uuid("reported_account_id")
      .notNull()
      .references(() => account.id),
    source: reportSource("source").notNull(),
    reason: sanctionReason("reason").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    outcome: reportOutcome("outcome"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by").references(() => identity.id),
    // Erasure deletes a lifted sanction (ADR-024 §8); the report keeps its outcome.
    sanctionId: uuid("sanction_id").references(() => sanction.id, { onDelete: "set null" }),
    // The conversation a report was made from (#351), null once it is gone;
    // its copy is in report_message either way.
    conversationId: uuid("conversation_id").references(() => conversation.id, {
      onDelete: "set null",
    }),
    // The pointer at one photo (#476): a line of the copy, or a photo of the card.
    lineSeq: integer("line_seq"),
    photoId: uuid("photo_id").references(() => photo.id, { onDelete: "set null" }),
    photoPointed: boolean("photo_pointed").notNull().default(false),
  },
  (table) => [
    // The day's count and the export: the reporter's rows by time.
    index("report_reporter_created_idx").on(table.reporterAccountId, table.createdAt),
    // The reports rule's window (#105): the reported account's rows by time.
    index("report_reported_created_idx").on(table.reportedAccountId, table.createdAt),
    // One open report per pair; a second one while it is open writes nothing.
    uniqueIndex("report_open_pair_idx")
      .on(table.reporterAccountId, table.reportedAccountId)
      .where(sql`${table.decidedAt} IS NULL`),
    // The SET NULL on every photo deletion looks reports up by photo; without this it scans.
    index("report_photo_idx").on(table.photoId).where(sql`${table.photoId} IS NOT NULL`),
    check("report_not_self_check", sql`${table.reporterAccountId} <> ${table.reportedAccountId}`),
    check(
      "report_note_check",
      sql`${table.note} IS NULL OR char_length(${table.note}) BETWEEN 1 AND 500`,
    ),
    check(
      "report_decision_check",
      sql`(${table.outcome} IS NULL) = (${table.decidedAt} IS NULL)
        AND (${table.decidedBy} IS NULL) = (${table.decidedAt} IS NULL)
        AND (${table.sanctionId} IS NULL OR ${table.outcome} = 'acted')`,
    ),
    // A card's report names no conversation. Written without naming the new
    // source: a value added in this migration cannot be used in its transaction.
    check(
      "report_conversation_check",
      sql`${table.conversationId} IS NULL OR ${table.source} <> 'card'`,
    ),
    // A conversation's report points at a line, a card's at a photo, never the other way.
    check(
      "report_line_seq_check",
      sql`${table.lineSeq} IS NULL OR (${table.source} = 'conversation' AND ${table.lineSeq} >= 1)`,
    ),
    check(
      "report_photo_check",
      sql`(NOT ${table.photoPointed} OR ${table.source} = 'card')
        AND (${table.photoId} IS NULL OR ${table.photoPointed})`,
    ),
  ],
);

/** Whose line a copied message was, seen from the report: the reporter's own, or the reported person's. */
export const reportMessageSide = pgEnum("report_message_side", ["reporter", "reported"]);

/**
 * The frozen copy of a conversation (#351, ADR-030 §12): every message it
 * held when the report was filed, both people's, copied in the report's
 * transaction under the conversation's lock, with its place, whose it was,
 * its kind, its words and its photo. The moderators read it in the panel
 * (#312, behind the audit row `conversation.view`); nobody else does, and its
 * words reach no log line, error detail or event (rule 5). It goes with its
 * report (twelve months from filing, the night's `prune-reports`). A photo it
 * names outlives its sender's erasure while a copy holds it, and goes with
 * the last copy that does (no ON DELETE: a path that forgot the hold fails
 * rather than empties the copy).
 */
export const reportMessage = pgTable(
  "report_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => report.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    side: reportMessageSide("side").notNull(),
    kind: messageKind("kind").notNull(),
    body: text("body"),
    photoId: uuid("photo_id").references(() => photo.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("report_message_seq_idx").on(table.reportId, table.seq),
    // The hold at erasure and the prune's release look copies up by photo.
    index("report_message_photo_idx").on(table.photoId).where(sql`${table.photoId} IS NOT NULL`),
  ],
);
