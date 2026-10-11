import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { identity } from "./identity.ts";

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
