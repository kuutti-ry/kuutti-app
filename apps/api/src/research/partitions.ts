import { type Queryable, transaction } from "@kuutti/db";
import type { NightlyJob } from "../jobs/nightly.ts";

/**
 * The monthly partitions of `events` (#50, ADR-011; rules/db.md: monthly
 * partitions, 90-day retention). Created ahead, never on demand: the current
 * and the next month exist after boot and after every nightly run, and a
 * partition whose range *began* the retention ago or earlier is dropped whole:
 * the binding research text promises "at most 90 days" (legal.research.summary),
 * so a row lives between about 60 and 90 days, never longer. No row is ever
 * deleted (the table's triggers refuse it); retention is the drop. Month
 * bounds are UTC: research reads months, not Finnish days.
 */
export const EVENTS_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Distinct from the migration lock (MIGRATE_LOCK_KEY); two containers booting at once take turns here. */
const PARTITIONS_LOCK_KEY = 725_121_150;

export type MonthPartition = { name: string; from: Date; to: Date };

const pad = (n: number) => String(n).padStart(2, "0");

/** `events_YYYY_MM` with its half-open UTC range. */
export function monthPartition(year: number, month: number): MonthPartition {
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));
  return { name: `events_${from.getUTCFullYear()}_${pad(from.getUTCMonth() + 1)}`, from, to };
}

/** The current and the next month, as of `now`. */
export function partitionsAhead(now: Date): MonthPartition[] {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  return [monthPartition(year, month), monthPartition(year, month + 1)];
}

const PARTITION_NAME = /^events_(\d{4})_(\d{2})$/;

/** The range start of a partition by its name, or null for a name that is not ours. */
export function partitionStart(name: string): Date | null {
  const m = PARTITION_NAME.exec(name);
  if (!m) return null;
  return monthPartition(Number(m[1]), Number(m[2])).from;
}

async function existing(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ relname: string }>(
    `SELECT c.relname FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'events' ORDER BY 1`,
  );
  return rows.map((r) => r.relname);
}

export async function ensureEventPartitions(
  db: Queryable,
  now: Date,
): Promise<{ created: number; partitions: string[] }> {
  return transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [PARTITIONS_LOCK_KEY]);
    const have = new Set(await existing(tx));
    let created = 0;
    for (const p of partitionsAhead(now)) {
      if (have.has(p.name)) continue;
      // DDL takes no bind parameters; the name and bounds are computed above
      // from a Date, never from input, and the name matches PARTITION_NAME.
      await tx.query(
        `CREATE TABLE IF NOT EXISTS "${p.name}" PARTITION OF "events"
         FOR VALUES FROM ('${p.from.toISOString()}') TO ('${p.to.toISOString()}')`,
      );
      // The parent's row triggers are cloned onto the partition; a statement
      // trigger is not, so TRUNCATE of the partition by name gets its own.
      await tx.query(
        `CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON "${p.name}"
         FOR EACH STATEMENT EXECUTE FUNCTION events_immutable()`,
      );
      created += 1;
    }
    return { created, partitions: [...(await existing(tx))] };
  });
}

export async function pruneEventPartitions(
  db: Queryable,
  now: Date,
): Promise<{ dropped: number; partitions: string[] }> {
  const cutoff = new Date(now.getTime() - EVENTS_RETENTION_DAYS * DAY_MS);
  return transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [PARTITIONS_LOCK_KEY]);
    let dropped = 0;
    for (const name of await existing(tx)) {
      const start = partitionStart(name);
      if (!start || start.getTime() > cutoff.getTime()) continue;
      // Its oldest row has reached the retention: the whole month goes, the
      // one deletion the table allows, and nothing in it is older than promised.
      await tx.query(`DROP TABLE "${name}"`);
      dropped += 1;
    }
    return { dropped, partitions: [...(await existing(tx))] };
  });
}

/** The nightly job: next month ready, months past retention gone. */
export function researchEventsJob(deps: { db: Queryable; now: () => Date }): NightlyJob {
  return {
    name: "research-events-partitions",
    run: async () => {
      // One clock read: a month rolling over between the two steps would leave a month uncreated.
      const now = deps.now();
      const ensured = await ensureEventPartitions(deps.db, now);
      const pruned = await pruneEventPartitions(deps.db, now);
      return {
        created: ensured.created,
        dropped: pruned.dropped,
        partitions: pruned.partitions.length,
      };
    },
  };
}
