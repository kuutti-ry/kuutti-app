import { type Queryable, transaction } from "@kuutti/db";
import { moveFigures, type WaitlistCounts } from "@kuutti/schema";
import { finnishDay } from "../lib/finnish-day.ts";
import type { Logger } from "../lib/logger.ts";
import { preferencesFrom } from "../matching/index.ts";
import { listPonds, readStandingFigures, readWaitlistK } from "../pond/index.ts";
import { answeredPromptsOf, completeness } from "../profile/index.ts";
import type { NightlyJob } from "./nightly.ts";

/**
 * The waitlist counter's figures (#54, ADR-013). The waitlist is the people
 * themselves: live, bank-verified accounts with a pond. Once a day they are
 * counted per pond, and a pond's figures move when at least k people have
 * come or gone since they were taken (`moveFigures`): a count that followed
 * every day would say what the one person who came that day declared. The
 * public route of the pond slice serves the figures after suppression. It
 * lives here and not in a slice because it reads across several (accounts,
 * profiles, photos, preferences, ponds) and none of them should depend on the
 * others for it (rules/layout.md).
 *
 * Raw parameterised SQL for the same reason as pond/repo.ts: `db` is the
 * Queryable seam the test harness hands a rolled-back transaction through.
 * No statement here takes input from a request.
 */
export type WaitlistDeps = { db: Queryable; logger: Logger; now: () => Date };

/**
 * One count at a time, across every process that may run one (two containers
 * overlap during a deploy, and each takes the first figures at boot). Without
 * it two counts read the same standing row, each finds that the pond has moved
 * by k, and the second overwrites the first with a total one person apart:
 * the very difference the step rule is there to keep from being said.
 */
export const WAITLIST_LOCK_KEY = 725_121_154;

type FactsRow = {
  pond_id: string;
  gender: string | null;
  state: string;
  display_name: string | null;
  bio: string | null;
  bio_preset: string | null;
  prompts: unknown;
  approved_photos: string;
  seeks: unknown;
  age_window: unknown;
};

const empty = (): WaitlistCounts => ({ verified: 0, woman: 0, man: 0, nonBinary: 0, finishing: 0 });

/**
 * A shadow-banned account counts exactly like an active one, here and in
 * `finishing`. Left out, its owner could find the ban out: move between two
 * ponds, or take a photo away, and watch whether the figures ever follow.
 */
const STANDS_AS_ACTIVE = new Set(["active", "shadow_banned"]);

/**
 * Exact counts per pond, for ponds somebody chose. One read over every account
 * that counts, with no account id in what comes back: this is a nightly
 * aggregate, not a caller's data (rule 6 is about a session's own rows). The
 * tables are the shared ones of packages/db, read only. Whether a profile is
 * complete is decided by `completeness()` itself, from the same facts the
 * profile screen gathers, so the counter and the screen cannot disagree.
 */
export async function countPonds(db: Queryable): Promise<Map<string, WaitlistCounts>> {
  const { rows } = await db.query<FactsRow>(
    `SELECT a.pond_id, a.gender, a.state, p.display_name, p.bio, p.bio_preset, p.prompts,
            (SELECT count(*) FROM photo ph
              WHERE ph.account_id = a.id AND ph.state = 'approved') AS approved_photos,
            (SELECT r.value FROM preferences r
              WHERE r.account_id = a.id AND r.mode = 'hard' AND r.field = 'seeks') AS seeks,
            (SELECT r.value FROM preferences r
              WHERE r.account_id = a.id AND r.mode = 'hard' AND r.field = 'age_window') AS age_window
     FROM account a
     JOIN identity i ON i.id = a.identity_id
     LEFT JOIN profile p ON p.account_id = a.id
     WHERE a.pond_id IS NOT NULL
       AND a.state IN ('registered', 'active', 'shadow_banned')
       AND i.standing = 'ok'`,
  );
  const ponds = new Map<string, WaitlistCounts>();
  for (const row of rows) {
    const counts = ponds.get(row.pond_id) ?? empty();
    counts.verified += 1;
    if (row.gender === "woman") counts.woman += 1;
    else if (row.gender === "man") counts.man += 1;
    else if (row.gender === "non_binary") counts.nonBinary += 1;
    const preferences = preferencesFrom({ seeks: row.seeks, ageWindow: row.age_window });
    const ready =
      STANDS_AS_ACTIVE.has(row.state) &&
      completeness({
        displayName: row.display_name,
        bio: row.bio,
        bioPreset: row.bio_preset,
        answeredPrompts: answeredPromptsOf(row.prompts),
        approvedPhotos: Number(row.approved_photos),
        seeks: preferences.seeks,
        ageWindow: preferences.ageWindow,
      }).complete;
    if (!ready) counts.finishing += 1;
    ponds.set(row.pond_id, counts);
  }
  return ponds;
}

/** `counted` is false when the day had its count already and this run did nothing. */
export type SnapshotResult = { day: string; ponds: number; moved: number; counted: boolean };

/**
 * Counts every pond and moves the figures of those that have moved far enough.
 * Every pond has a row, a pond nobody chose one of zeros, so the list never
 * says which ponds are small by leaving them out. One row per pond: the
 * figures that are replaced are gone, and no series of daily counts is kept.
 *
 * At most one count a Finnish calendar day, whichever process asks: every API
 * process arms the nightly job, and two that overlap during a deploy take the
 * lock one after the other. Every row's `taken_at` is the last count, so the
 * newest of them says which day was counted last.
 */
export async function takeSnapshot(deps: WaitlistDeps): Promise<SnapshotResult> {
  const at = deps.now();
  const day = finnishDay(at);
  const result = await transaction(deps.db, async (tx) => {
    // Before anything is read: what this count compares with must be what the last one left.
    await tx.query("SELECT pg_advisory_xact_lock($1)", [WAITLIST_LOCK_KEY]);
    const last = await tx.query<{ at: Date | null }>(
      "SELECT max(taken_at) AS at FROM waitlist_snapshot",
    );
    const lastAt = last.rows[0]?.at ?? null;
    if (lastAt !== null && finnishDay(lastAt) === day) {
      return { day, ponds: 0, moved: 0, counted: false };
    }
    const k = await readWaitlistK(tx);
    const counts = await countPonds(tx);
    const standing = await readStandingFigures(tx);
    const ponds = await listPonds(tx);
    let moved = 0;
    for (const pond of ponds) {
      const was = standing.get(pond.id)?.counts ?? null;
      const next = moveFigures(was, counts.get(pond.id) ?? empty(), k);
      if (next === was) continue;
      moved += 1;
      await tx.query(
        `INSERT INTO waitlist_snapshot (pond_id, day, verified, woman, man, non_binary, finishing, taken_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (pond_id) DO UPDATE
           SET day = EXCLUDED.day, verified = EXCLUDED.verified, woman = EXCLUDED.woman,
               man = EXCLUDED.man, non_binary = EXCLUDED.non_binary,
               finishing = EXCLUDED.finishing, taken_at = EXCLUDED.taken_at`,
        [pond.id, day, next.verified, next.woman, next.man, next.nonBinary, next.finishing, at],
      );
    }
    // The ponds that did not move were counted too: the mark of the day's count is on every row.
    await tx.query("UPDATE waitlist_snapshot SET taken_at = $1", [at]);
    return { day, ponds: ponds.length, moved, counted: true };
  });
  // How many ponds there are and how many moved, never who, where or how many people.
  deps.logger.info(
    result,
    result.counted ? "waitlist snapshot" : "waitlist snapshot: counted today already",
  );
  return result;
}

/** The first figures for a database that has none, so the route has something to say after a first deploy. */
export async function ensureFirstSnapshot(deps: WaitlistDeps): Promise<SnapshotResult | null> {
  const { rows } = await deps.db.query("SELECT 1 FROM waitlist_snapshot LIMIT 1");
  return rows.length === 0 ? takeSnapshot(deps) : null;
}

/** The nightly job: the day's count. */
export function waitlistJob(deps: WaitlistDeps): NightlyJob {
  return {
    name: "waitlist-snapshot",
    run: async () => {
      const result = await takeSnapshot(deps);
      return { ponds: result.ponds, moved: result.moved };
    },
  };
}
