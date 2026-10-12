import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
