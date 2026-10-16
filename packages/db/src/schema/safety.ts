import { sql } from "drizzle-orm";
import { check, index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
 * `detail` is bounded structured data, never text from a person.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorIdentityId: uuid("actor_identity_id")
      .notNull()
      .references(() => identity.id),
    // e.g. photo.view, photo.approve, photo.reject; a closed set in code.
    action: text("action").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    detail: jsonb("detail"),
  },
  (table) => [
    index("audit_log_subject_idx").on(table.subjectType, table.subjectId),
    index("audit_log_actor_at_idx").on(table.actorIdentityId, table.at),
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
  ],
);
