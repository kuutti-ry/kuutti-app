import { type Queryable, transaction } from "@kuutti/db";
import {
  AgeBand,
  Gender,
  RESEARCH_EVENTS,
  RESEARCH_FIELD_KEYS,
  RESEARCH_K_MIN,
  type ResearchEventName,
  researchFieldsOf,
} from "@kuutti/schema";
import { z } from "zod";
import type { NightlyJob } from "../jobs/nightly.ts";
import type { Logger } from "../lib/logger.ts";
import { census, type Released, remember } from "./copy-census.ts";
import { type CopyRow, encodeDay, releasedIn } from "./copy-file.ts";
import type { CopyStore } from "./copy-store.ts";
import {
  EVENTS_RETENTION_DAYS,
  eventPartitions,
  type MonthPartition,
  partitionStart,
} from "./partitions.ts";

/**
 * The research copy (#194, TD-5, ADR-029): every night, each UTC day the
 * events table still holds and the copy lacks becomes one Parquet file, in
 * ascending order, so that each file is the next one's prior for the census
 * (copy-census.ts). A file is written once and never rewritten; a night that
 * fails writes what it finished and the next night catches up on the rest,
 * as long as the table still holds the day. Runs before the partitions job,
 * so a month is copied before the prune can drop it (ADR-029 §6).
 */
export type CopyDeps = { db: Queryable; store: CopyStore; now: () => Date };

/** Distinct from the partitions' and the jobs' keys; a second container finds it held and leaves the night to the first. */
export const COPY_LOCK_KEY = 725_121_151;
/** How far back the census counts: as far as the table keeps (ADR-029 §4). */
const WINDOW_DAYS = EVENTS_RETENTION_DAYS;
/**
 * A day is closed an hour after it ends: an event stamped 23:00 may commit a
 * moment after midnight. The night runs at 04:00 in Helsinki, one or two
 * hours after midnight UTC.
 */
const SETTLE_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const dayOf = (at: Date) => at.toISOString().slice(0, 10);
const startOf = (day: string) => new Date(`${day}T00:00:00.000Z`);
const addDays = (day: string, n: number) => dayOf(new Date(startOf(day).getTime() + n * DAY_MS));

export type CopyRun = {
  /** 1 when another container held the lock and this run wrote nothing. */
  skipped: number;
  /** Days written by this run. */
  written: number;
  /** Rows read from the table for those days. */
  rows: number;
  released: number;
  /** Of the released, those under a generalised cell. */
  generalised: number;
  dropped: number;
  unreadable: number;
};

const NOTHING: CopyRun = {
  skipped: 0,
  written: 0,
  rows: 0,
  released: 0,
  generalised: 0,
  dropped: 0,
  unreadable: 0,
};

type EventRow = {
  at: Date;
  name: string;
  research_id: string;
  consent_version: string;
  pond: string | null;
  age_band: string;
  snapshot: unknown;
  props: unknown;
};

/** The snapshot as track() stores it, read leniently: a key the registry no longer knows is ignored. */
const StoredSnapshot = z.object({ gender: Gender.nullable(), fields: z.unknown() });

/**
 * A stored row as the registry reads it today, or null when it no longer
 * does: a retired event name, props its strict schema refuses, a band or a
 * gender outside the closed lists. Only the registry's values pass, so no
 * text reaches a file (rule 5); a research field that no longer parses reads
 * as unanswered (ADR-011 §9).
 */
function readEvent(row: EventRow): CopyRow | null {
  if (!Object.hasOwn(RESEARCH_EVENTS, row.name)) return null;
  const props = RESEARCH_EVENTS[row.name as ResearchEventName].props.safeParse(row.props);
  const ageBand = AgeBand.safeParse(row.age_band);
  const snapshot = StoredSnapshot.safeParse(row.snapshot);
  if (!props.success || !ageBand.success || !snapshot.success) return null;
  const fields = researchFieldsOf(snapshot.data.fields) as Record<string, string | undefined>;
  return {
    at: row.at,
    name: row.name,
    researchId: row.research_id,
    consentVersion: row.consent_version,
    cell: {
      pond: row.pond,
      ageBand: ageBand.data,
      gender: snapshot.data.gender,
      fields: Object.fromEntries(RESEARCH_FIELD_KEYS.map((key) => [key, fields[key] ?? null])),
    },
    props: props.data as Record<string, unknown>,
  };
}

async function eventsOfDay(
  db: Queryable,
  day: string,
): Promise<{ rows: CopyRow[]; unreadable: number }> {
  // Every row of the day, not one person's: the copy is the block, and no
  // account is named; the research_id is the key (rule 5).
  const { rows } = await db.query<EventRow>(
    `SELECT at, name, research_id::text AS research_id, consent_version, pond, age_band, snapshot, props
     FROM events WHERE at >= $1 AND at < $2`,
    [startOf(day), startOf(addDays(day, 1))],
  );
  const read = rows.map(readEvent);
  const kept = read.filter((row): row is CopyRow => row !== null);
  return { rows: kept, unreadable: rows.length - kept.length };
}

/**
 * The pseudonyms whose research consent is live tonight: the only carriers the
 * census counts (ADR-029 §4). An account has at most one mapping row, so a
 * live pseudonym is a person; one left behind by a withdrawal or an erasure
 * counts for nobody. Every row, not one person's, and the pseudonym alone,
 * never the account: a few thousand rows at most, read once a run, which
 * needs no list of the ids in play first.
 */
async function livePseudonyms(db: Queryable): Promise<Set<string>> {
  const { rows } = await db.query<{ research_id: string }>(
    "SELECT research_id::text AS research_id FROM research_subject",
  );
  return new Set(rows.map((row) => row.research_id));
}

/**
 * Writes every missing day from the oldest partition's first day to the
 * last closed day. Fails closed: a store or database error, a prior file
 * that cannot be read, or a file of a day not yet closed stops the run
 * before anything is released without its count, and the night logs the
 * failure (jobs/nightly.ts).
 */
export async function writeResearchCopy(deps: CopyDeps): Promise<CopyRun> {
  return transaction(deps.db, async (tx) => {
    const { rows: lock } = await tx.query<{ got: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1) AS got",
      [COPY_LOCK_KEY],
    );
    if (!lock[0]?.got) return { ...NOTHING, skipped: 1 };
    const starts = (await eventPartitions(tx))
      .map(partitionStart)
      .filter((start): start is Date => start !== null)
      .map(dayOf)
      .sort();
    const first = starts[0];
    const last = addDays(dayOf(new Date(deps.now().getTime() - SETTLE_MS)), -1);
    if (first === undefined || first > last) return NOTHING;

    const have = new Set(await deps.store.days(addDays(first, -WINDOW_DAYS)));
    // No night of ours writes a day before it has closed, so such a file was
    // put there by someone else (a preview shares staging's instance role,
    // ADR-029 §12). Read as prior, its pseudonyms would open cells under k on
    // the days after it: nothing is released until somebody has looked.
    const ahead = [...have].filter((day) => day > last).length;
    if (ahead > 0) throw new Error(`research copy: ${ahead} file(s) of a day not yet closed`);
    // Each prior day's release is read once per run; a day this run wrote is known already.
    const known = new Map<string, Awaited<ReturnType<typeof releasedIn>>>();
    const releasedOn = async (day: string) => {
      let rows = known.get(day);
      if (!rows) {
        rows = await releasedIn(await deps.store.get(day));
        known.set(day, rows);
      }
      return rows;
    };

    const live = await livePseudonyms(tx);
    const run = { ...NOTHING };
    for (let day = first; day <= last; day = addDays(day, 1)) {
      if (have.has(day)) continue;
      const prior: Released = new Map();
      for (let d = addDays(day, -WINDOW_DAYS); d < day; d = addDays(d, 1)) {
        if (have.has(d)) remember(prior, await releasedOn(d));
      }
      const { rows, unreadable } = await eventsOfDay(tx, day);
      const result = census(rows, prior, RESEARCH_K_MIN, (id) => live.has(id));
      const file = encodeDay(result.released, {
        day,
        k: RESEARCH_K_MIN,
        dropped: result.dropped,
        unreadable,
      });
      // False: another writer was first, and its file is the day's; it is read as such.
      if (await deps.store.putNew(day, file)) {
        known.set(day, result.released);
        run.written += 1;
        run.rows += rows.length + unreadable;
        run.released += result.released.length;
        run.generalised += result.generalised;
        run.dropped += result.dropped;
        run.unreadable += unreadable;
      }
      have.add(day);
    }
    return run;
  });
}

/** The nightly job; its line carries counts only. */
export function researchCopyJob(deps: CopyDeps): NightlyJob {
  return { name: "research-export", run: () => writeResearchCopy(deps) };
}

/**
 * Before the prune drops a month (ADR-029 §6): the copy runs once more,
 * then every day of the months to drop must have its file. Returns the days
 * that do not, each logged as lost. The prune drops them anyway: the binding
 * text promises the table keeps an event at most ninety days, and that
 * promise wins over the copy (P1, the maintainer's to confirm).
 */
export async function copiedBeforeDrop(
  deps: CopyDeps & { logger: Logger },
  months: readonly MonthPartition[],
): Promise<number> {
  if (months.length === 0) return 0;
  try {
    await writeResearchCopy(deps);
  } catch (err) {
    deps.logger.error({ err }, "research copy failed before the prune");
  }
  const due = months.flatMap((month) => {
    const days: string[] = [];
    for (let day = dayOf(month.from); day < dayOf(month.to); day = addDays(day, 1)) days.push(day);
    return days;
  });
  let missing = due.length;
  try {
    const have = new Set(await deps.store.days([...due].sort()[0] as string));
    missing = due.filter((day) => !have.has(day)).length;
  } catch (err) {
    deps.logger.error({ err }, "research copy could not be listed before the prune");
  }
  if (missing > 0) {
    deps.logger.error({ days: missing }, "research events dropped without their copy");
  }
  return missing;
}
