import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { account } from "./identity.ts";

/**
 * The research_id mapping (#50, TD-5, ADR-011): one row while the research
 * consent is active. Written in the transaction that records the consent,
 * deleted in the one that withdraws it and by erasure (rules/db.md); the
 * events keyed by research_id stay and cannot be joined back once the row is
 * gone, which is the point. The id is random, never derived from anything
 * about the person, so a later opt-in is a fresh pseudonym. It appears in no
 * response, the export included (rules/schema.md).
 *
 * The `events` table itself is a partitioned table, which the schema DSL
 * cannot express: it lives in a custom migration (rule 10), cited in ADR-011.
 */
export const researchSubject = pgTable("research_subject", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => account.id),
  researchId: uuid("research_id").notNull().unique().defaultRandom(),
  /** The consent_version of the wording the person read (ADR-010), stamped on every event. */
  consentVersion: text("consent_version").notNull(),
  enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
});
