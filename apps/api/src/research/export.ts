import type { Queryable } from "@kuutti/db";
import type { ResearchExport } from "@kuutti/schema";
import * as repo from "./repo.ts";

/**
 * What research holds about the person, for the export (#51, ADR-007 §4): the
 * enrolment alone, never the research_id (rules/schema.md) and never the
 * events (ADR-011 §10, the maintainer's call of 15/10/2026). The events are
 * the researchers' material, pseudonymised while the mapping row lives and
 * anonymised in every copy that leaves the database; they are not a record
 * about the person. Not enrolled: nothing, because nothing can be found.
 */
export async function exportResearch(db: Queryable, accountId: string): Promise<ResearchExport> {
  const subject = await repo.findSubject(db, accountId);
  if (!subject) return { enrolled: false, since: null, consentVersion: null };
  return {
    enrolled: true,
    since: subject.enrolledAt.toISOString(),
    consentVersion: subject.consentVersion,
  };
}
