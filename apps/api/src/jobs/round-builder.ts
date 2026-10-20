import type { Queryable } from "@kuutti/db";
import type { RoundReason } from "@kuutti/schema";
import { finnishDay } from "../lib/finnish-day.ts";
import type { Logger } from "../lib/logger.ts";
import { matchingConfigNumbers } from "../lib/matching-config.ts";
import { roundOrder, saveRound } from "../matching/index.ts";
import type { NightlyJob } from "./nightly.ts";
import { type Subject, subjectsOfPond } from "./pond-gate.ts";

/**
 * The round builder, its first cut (#95, ADR-035; the maintainer, 20/10/2026):
 * every person whose matching has opened (#94) gets a round for the Finnish
 * day, at night after the gate's count, or at the day's first read when the
 * night built none. It lives with the jobs and not in a slice for the gate
 * count's reason: it reads across accounts, profiles, photos, preferences,
 * consents, blocks, gates, rounds and conversations. The rule of whom and in
 * which order is the matching slice's (`roundOrder`), the one writer too
 * (`saveRound`).
 *
 * A candidate is somebody of the pond who is seen by others and let in, as
 * the gate counts a pool (ADR-015 §1), in each other's pool both ways, not
 * kept apart by a hidden field, with no conversation between the two (the
 * match's record, ADR-031), not shown within `shown_cooldown_days` and not
 * passed within `pass_cooldown_days`. Somebody of an earlier round past those
 * comes back as `seen_before` (TD-12). Fewer candidates than `round_size`
 * make a shorter round, none an empty one: nothing fills it.
 *
 * Nothing it reads or decides is logged but how many: whose round has whom
 * in it is the round record's, and the export's (ADR-034 §7).
 */
export type BuilderDeps = { db: Queryable; logger: Logger; now: () => Date };

const KEYS = ["round_size", "shown_cooldown_days", "pass_cooldown_days"] as const;
type BuilderConfig = Record<(typeof KEYS)[number], number>;

export type BuildCount = { ponds: number; built: number; cards: number; failed: number };

/**
 * Whom the owner may not be shown today, and whom they were shown before.
 * Earlier days only: today's round is the one being built.
 */
async function historyOf(
  db: Queryable,
  ownerId: string,
  day: string,
  config: BuilderConfig,
): Promise<{ excluded: Set<string>; seen: Set<string> }> {
  const { rows } = await db.query<{ id: string; cooling: boolean }>(
    `SELECT e.candidate_id AS id,
            bool_or(r.day > $2::date - $3::int
                    OR (e.decision = 'pass' AND r.day > $2::date - $4::int)) AS cooling
       FROM rounds r JOIN round_entries e ON e.round_id = r.id
      WHERE r.account_id = $1 AND r.day < $2::date
      GROUP BY e.candidate_id
     UNION ALL
     SELECT other.account_id, true
       FROM conversation_participant mine
       JOIN conversation_participant other
         ON other.conversation_id = mine.conversation_id AND other.account_id <> mine.account_id
      WHERE mine.account_id = $1`,
    [ownerId, day, config.shown_cooldown_days, config.pass_cooldown_days],
  );
  return {
    excluded: new Set(rows.filter((row) => row.cooling).map((row) => row.id)),
    seen: new Set(rows.map((row) => row.id)),
  };
}

/** One pond's rounds for the day: of everybody open, or of one person. */
async function buildPond(
  deps: BuilderDeps,
  pondId: string,
  round: { day: string; at: Date; config: BuilderConfig },
  only?: string,
): Promise<Omit<BuildCount, "ponds">> {
  const subjects = await subjectsOfPond(deps.db, pondId, round.at);
  const owners = subjects.filter(
    (subject) => subject.openedAt !== null && (only === undefined || subject.id === only),
  );
  const count = { built: 0, cards: 0, failed: 0 };
  if (owners.length === 0) return count;
  // Whoever has today's round already keeps it; nobody's is built twice.
  const { rows } = await deps.db.query<{ account_id: string }>(
    "SELECT account_id FROM rounds WHERE day = $1 AND account_id = ANY($2::uuid[])",
    [round.day, owners.map((owner) => owner.id)],
  );
  const done = new Set(rows.map((row) => row.account_id));
  const shown = subjects.filter((subject) => subject.visible && subject.admittedAt !== null);
  for (const owner of owners) {
    if (done.has(owner.id)) continue;
    try {
      const entries = await placesOf(deps.db, owner, shown, round);
      const saved = await saveRound(deps, {
        accountId: owner.id,
        day: round.day,
        ordering: "count",
        entries,
      });
      if (saved) {
        count.built += 1;
        count.cards += entries.length;
      }
    } catch (err) {
      // One person's round failing builds everybody else's; the read builds it later.
      count.failed += 1;
      deps.logger.error({ job: "round-builder", accountId: owner.id, err }, "round not built");
    }
  }
  return count;
}

async function placesOf(
  db: Queryable,
  owner: Subject,
  shown: readonly Subject[],
  round: { day: string; config: BuilderConfig },
): Promise<{ candidateId: string; reason: RoundReason }[]> {
  const history = await historyOf(db, owner.id, round.day, round.config);
  const ordered = roundOrder(
    owner,
    shown.filter((subject) => !history.excluded.has(subject.id)),
    { day: round.day, size: round.config.round_size },
  );
  return ordered.map((candidate) => ({
    candidateId: candidate.id,
    reason: history.seen.has(candidate.id) ? "seen_before" : "matches_filters",
  }));
}

/** Every open person's round for the day it is: the night's, after the gate's count. */
export async function buildRounds(deps: BuilderDeps): Promise<BuildCount> {
  const at = deps.now();
  const day = finnishDay(at);
  const config = await matchingConfigNumbers(deps.db, KEYS);
  const { rows } = await deps.db.query<{ pond_id: string }>(
    "SELECT DISTINCT pond_id FROM gate WHERE opened_at IS NOT NULL ORDER BY pond_id",
  );
  const total: BuildCount = { ponds: rows.length, built: 0, cards: 0, failed: 0 };
  for (const { pond_id } of rows) {
    const pond = await buildPond(deps, pond_id, { day, at, config });
    total.built += pond.built;
    total.cards += pond.cards;
    total.failed += pond.failed;
  }
  return total;
}

/**
 * The person's round for the day it is, when they have none and their
 * matching has opened in the pond they live in: the day's first read asks
 * (ADR-035 §5). Whether it built one; a read beside it that built first
 * leaves this one unwritten (`saveRound` keeps the first).
 */
export async function buildRoundOf(deps: BuilderDeps, accountId: string): Promise<boolean> {
  const { rows } = await deps.db.query<{ pond_id: string }>(
    `SELECT g.pond_id FROM gate g JOIN account a ON a.id = g.account_id AND a.pond_id = g.pond_id
      WHERE g.account_id = $1 AND g.opened_at IS NOT NULL
        AND a.state IN ('active', 'shadow_banned')`,
    [accountId],
  );
  const pondId = rows[0]?.pond_id;
  if (!pondId) return false;
  const at = deps.now();
  const config = await matchingConfigNumbers(deps.db, KEYS);
  const built = await buildPond(deps, pondId, { day: finnishDay(at), at, config }, accountId);
  return built.built === 1;
}

/** The nightly job: everybody's round for the day, after the gate has let people in. */
export function roundsJob(deps: BuilderDeps): NightlyJob {
  return { name: "round-builder", run: () => buildRounds(deps) };
}
