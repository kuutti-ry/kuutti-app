import { type Queryable, transaction } from "@kuutti/db";
import { moveFigures, type PondCounterCounts, seeksBand } from "@kuutti/schema";
import { CURRENT_CONSENT_VERSIONS } from "../identity/index.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import type { Logger } from "../lib/logger.ts";
import { preferencesFrom } from "../matching/index.ts";
import { listPonds, readPondCounterK, readStandingFigures } from "../pond/index.ts";
import type { NightlyJob } from "./nightly.ts";
import { PROFILE_FACTS, profileComplete } from "./pool.ts";

/**
 * The pond counter's figures (#54, #581, ADR-013). It counts the people
 * themselves: live, bank-verified accounts with a pond and a finished profile.
 * Once a day they are counted per pond, and a pond's figures move when at least
 * k people have come or gone since they were taken (`moveFigures`): a count that
 * followed every day would say that one person finished that day, and with the
 * bar what they seek. The pond slice's route serves the figures after
 * suppression. It lives here and not in a slice because it reads across several
 * (accounts, profiles, photos, preferences, ponds) and none of them should depend
 * on the others for it (rules/layout.md).
 *
 * Raw parameterised SQL for the same reason as pond/repo.ts: `db` is the
 * Queryable seam the test harness hands a rolled-back transaction through.
 * No statement here takes input from a request.
 */
export type PondCounterDeps = {
  db: Queryable;
  logger: Logger;
  now: () => Date;
};

/**
 * One count at a time, across every process that may run one (two containers
 * overlap during a deploy, and each takes the first figures at boot). Without
 * it two counts read the same standing row, each finds that the pond has moved
 * by k, and the second overwrites the first with a number one person apart:
 * the very difference the step rule is there to keep from being said.
 */
export const POND_COUNTER_LOCK_KEY = 725_121_154;

type FactsRow = {
  pond_id: string;
  display_name: string | null;
  bio: string | null;
  bio_preset: string | null;
  prompts: unknown;
  approved_photos: string;
  seeks: unknown;
  age_window: unknown;
  seeks_consented: boolean;
};

const empty = (): PondCounterCounts => ({
  finished: 0,
  seeksMen: 0,
  seeksEveryone: 0,
  seeksWomen: 0,
});

/**
 * Exact counts per pond, for the ponds with a finished profile. One read over
 * every account that may have one, with no account id in what comes back: this
 * is a nightly aggregate, not a caller's data (rule 6 is about a session's own
 * rows). The tables are the shared ones of packages/db, read only. A
 * shadow-banned account counts exactly like an active one: left out, its owner
 * could find the ban out by taking a photo away and watching whether the figures
 * ever follow. Whether a profile is complete is decided by `completeness()`
 * itself, from the same facts the profile screen gathers, so the counter and the
 * screen cannot disagree. A band holds only somebody whose consent to the answer
 * is current, as the rounds ask, and the current wording is what names this count
 * (ADR-013 §20): a finished profile on an older wording is finished, and in no
 * band.
 */
export async function countPonds(db: Queryable): Promise<Map<string, PondCounterCounts>> {
  const { rows } = await db.query<FactsRow>(
    `SELECT a.pond_id, p.display_name, p.bio, p.bio_preset, p.prompts,
            ${PROFILE_FACTS},
            EXISTS (SELECT 1 FROM consent c
              WHERE c.account_id = a.id AND c.kind = 'special_category'
                AND c.withdrawn_at IS NULL AND c.version = $1) AS seeks_consented
     FROM account a
     JOIN identity i ON i.id = a.identity_id
     LEFT JOIN profile p ON p.account_id = a.id
     WHERE a.pond_id IS NOT NULL
       AND a.state IN ('active', 'shadow_banned')
       AND i.standing = 'ok'`,
    [CURRENT_CONSENT_VERSIONS.special_category],
  );
  const ponds = new Map<string, PondCounterCounts>();
  for (const row of rows) {
    const preferences = preferencesFrom({ seeks: row.seeks, ageWindow: row.age_window });
    if (!profileComplete(row, preferences)) continue;
    const counts = ponds.get(row.pond_id) ?? empty();
    counts.finished += 1;
    const band = row.seeks_consented ? seeksBand(preferences.seeks) : null;
    if (band) counts[band] += 1;
    ponds.set(row.pond_id, counts);
  }
  return ponds;
}

/** `counted` is false when the day had its count already and this run did nothing. */
export type SnapshotResult = { day: string; ponds: number; moved: number; counted: boolean };

/**
 * Counts every pond and moves the figures of those that have moved far enough.
 * Every pond has a row, a pond nobody is in one of zeros, so the list never
 * says which ponds are small by leaving them out. One row per pond: the
 * figures that are replaced are gone, and no series of daily counts is kept.
 *
 * At most one count a Finnish calendar day, whichever process asks: every API
 * process arms the nightly job, and two that overlap during a deploy take the
 * lock one after the other. Every row's `taken_at` is the last count, so the
 * newest of them says which day was counted last.
 */
export async function takeSnapshot(deps: PondCounterDeps): Promise<SnapshotResult> {
  const at = deps.now();
  const day = finnishDay(at);
  const result = await transaction(deps.db, async (tx) => {
    // Before anything is read: what this count compares with must be what the last one left.
    await tx.query("SELECT pg_advisory_xact_lock($1)", [POND_COUNTER_LOCK_KEY]);
    const last = await tx.query<{ at: Date | null }>(
      "SELECT max(taken_at) AS at FROM pond_counter",
    );
    const lastAt = last.rows[0]?.at ?? null;
    if (lastAt !== null && finnishDay(lastAt) === day) {
      return { day, ponds: 0, moved: 0, counted: false };
    }
    const k = await readPondCounterK(tx);
    const counts = await countPonds(tx);
    const standing = await readStandingFigures(tx);
    const ponds = await listPonds(tx);
    let moved = 0;
    for (const pond of ponds) {
      const had = standing.get(pond.id);
      const was = had?.counts ?? null;
      const next = moveFigures(was, counts.get(pond.id) ?? empty(), k);
      if (next === was) continue;
      moved += 1;
      // The public `day` belongs to the public number: a move of the bands alone
      // leaves it, or it would say in public that whom people seek has changed.
      const movedOn = had && next.finished === had.counts.finished ? had.day : day;
      await tx.query(
        `INSERT INTO pond_counter (pond_id, day, finished,
                                        seeks_men, seeks_everyone, seeks_women, taken_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (pond_id) DO UPDATE
           SET day = EXCLUDED.day, finished = EXCLUDED.finished, seeks_men = EXCLUDED.seeks_men,
               seeks_everyone = EXCLUDED.seeks_everyone, seeks_women = EXCLUDED.seeks_women,
               taken_at = EXCLUDED.taken_at`,
        [pond.id, movedOn, next.finished, next.seeksMen, next.seeksEveryone, next.seeksWomen, at],
      );
    }
    // The ponds that did not move were counted too: the mark of the day's count is on every row.
    await tx.query("UPDATE pond_counter SET taken_at = $1", [at]);
    return { day, ponds: ponds.length, moved, counted: true };
  });
  // How many ponds there are and how many moved, never who, where or how many people.
  deps.logger.info(result, result.counted ? "pond counter" : "pond counter: counted today already");
  return result;
}

/** The first figures for a database that has none, so the route has something to say after a first deploy. */
export async function ensureFirstSnapshot(deps: PondCounterDeps): Promise<SnapshotResult | null> {
  const { rows } = await deps.db.query("SELECT 1 FROM pond_counter LIMIT 1");
  return rows.length === 0 ? takeSnapshot(deps) : null;
}

/** The nightly job: the day's count. */
export function pondCounterJob(deps: PondCounterDeps): NightlyJob {
  return {
    name: "pond-counter",
    run: async () => {
      const result = await takeSnapshot(deps);
      return { ponds: result.ponds, moved: result.moved };
    },
  };
}
