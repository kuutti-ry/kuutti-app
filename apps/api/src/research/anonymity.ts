import type { Queryable } from "@kuutti/db";
import { RESEARCH_K_MIN } from "@kuutti/schema";
import type { NightlyJob } from "../jobs/nightly.ts";
import type { Logger } from "../lib/logger.ts";

/**
 * The census of the research block (ADR-011 §9). A cell is one value of pond,
 * age band and snapshot; its size is the number of distinct pseudonyms in it
 * over the ninety days the table holds, never the number of rows: one
 * person's ten events are still one person. Any copy that leaves the database
 * must hold every cell to `RESEARCH_K_MIN`; this says, every night, whether
 * the live table does, so the first Parquet export (#194) does not meet the
 * problem first.
 */
export type AnonymityCensus = {
  /** Distinct cells in the table. */
  cells: number;
  /** Cells with fewer than k pseudonyms. */
  small: number;
  /** The smallest cell's pseudonyms; null when the table is empty. */
  smallest: number | null;
};

export async function anonymityCensus(db: Queryable, k: number): Promise<AnonymityCensus> {
  // Grouped by the jsonb value: two snapshots are one cell when they are equal
  // as documents, whatever key order they were written in.
  const { rows } = await db.query<{ cells: number; small: number; smallest: number | null }>(
    `WITH cells AS (
       SELECT count(DISTINCT research_id)::int AS subjects
       FROM events
       GROUP BY pond, age_band, snapshot)
     SELECT count(*)::int AS cells,
            (count(*) FILTER (WHERE subjects < $1))::int AS small,
            min(subjects)::int AS smallest
     FROM cells`,
    [k],
  );
  const row = rows[0];
  return { cells: row?.cells ?? 0, small: row?.small ?? 0, smallest: row?.smallest ?? null };
}

/**
 * The nightly job. The warning carries counts only: a cell's values are the
 * quasi-identifiers of the few people in it, and a log line is read by more
 * eyes than the table. A warning is not an incident, the live table is
 * pseudonymised data under consent; it is the copy that must be anonymous.
 */
export function researchAnonymityJob(deps: { db: Queryable; logger: Logger }): NightlyJob {
  return {
    name: "research-anonymity",
    run: async () => {
      const census = await anonymityCensus(deps.db, RESEARCH_K_MIN);
      if (census.small > 0) {
        deps.logger.warn({ k: RESEARCH_K_MIN, ...census }, "research events: cells under k");
      }
      return {
        k: RESEARCH_K_MIN,
        cells: census.cells,
        small: census.small,
        smallest: census.smallest ?? 0,
      };
    },
  };
}
