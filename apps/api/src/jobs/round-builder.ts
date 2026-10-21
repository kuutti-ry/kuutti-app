import type { Queryable } from "@kuutti/db";
import {
  type Relaxation,
  type RelaxationKind,
  type RelaxationOffer,
  ROUND_ENTRIES_MAX,
  type RoundReason,
  waitlistK,
} from "@kuutti/schema";
import { finnishDay } from "../lib/finnish-day.ts";
import type { Logger } from "../lib/logger.ts";
import { matchingConfigNumbers } from "../lib/matching-config.ts";
import {
  comingBackOrder,
  inEachOthersPool,
  likedYouPlaces,
  type PoolPerson,
  pausedOf,
  type RelaxedCandidate,
  relaxationsOf,
  relaxedBy,
  roundOrder,
  saveRound,
} from "../matching/index.ts";
import { saidInStep } from "../pond/index.ts";
import type { NightlyJob } from "./nightly.ts";
import { type Subject, subjectOf, subjectsOfPond } from "./pond-gate.ts";

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
 * The round's first places are the people whose like waits on the person
 * (#97, ADR-037), those who sent a fish ahead of the rest, labelled `fish`
 * (#378, ADR-039): liked on an ended day within `like_expiry_days`, not yet
 * answered, the oldest like first, up to `liked_you_cap`, each still in each
 * other's pool, labelled `liked_you`; no order moves them. A like the person
 * passed within `pass_cooldown_days`, or of somebody they have a
 * conversation with, never comes. Somebody whose like waits beyond the cap
 * waits for a later round and is no ordinary card meanwhile. A shadow-banned
 * person gets none of these places, and the likes wait for the lift.
 *
 * Nothing it reads or decides is logged but how many: whose round has whom
 * in it is the round record's, and the export's (ADR-034 §7).
 */
export type BuilderDeps = { db: Queryable; logger: Logger; now: () => Date };

const KEYS = [
  "round_size",
  "shown_cooldown_days",
  "pass_cooldown_days",
  "liked_you_cap",
  "like_expiry_days",
] as const;
type BuilderConfig = Record<(typeof KEYS)[number], number>;
/** The short pool reads the gate's step too (ADR-042 §4). */
const SHORT_POOL_KEYS = [...KEYS, "waitlist_k"] as const;

export type BuildCount = { ponds: number; built: number; cards: number; failed: number };

/** Whom the owner was shown before, by the rounds they opened (ADR-042 §1). */
type History = {
  /** Shown within `shown_cooldown_days`: an ordinary card waits it out. */
  cooling: Set<string>;
  /** Passed within `pass_cooldown_days`, or in a conversation with the owner: no card at all, a like of theirs neither. */
  refused: Set<string>;
  /** Everybody shown before, with when last, and whether the latest decision was a pass. */
  seen: Map<string, { lastShown: string; passed: boolean }>;
};

/**
 * Earlier days only, today's round being the one built or added to; and only
 * rounds the owner opened: a round built and never read showed nobody, so
 * its people neither cool down nor come back as seen before (ADR-042 §1).
 */
async function historyOf(
  db: Queryable,
  ownerId: string,
  day: string,
  config: BuilderConfig,
): Promise<History> {
  const { rows } = await db.query<{
    id: string;
    shown: boolean;
    refused: boolean;
    last_shown: string | null;
    passed: boolean;
  }>(
    `SELECT e.candidate_id AS id, bool_or(r.day > $2::date - $3::int) AS shown,
            bool_or(e.decision = 'pass' AND r.day > $2::date - $4::int) AS refused,
            max(r.day)::text AS last_shown,
            coalesce((array_agg(e.decision ORDER BY r.day DESC))[1] = 'pass', false) AS passed
       FROM rounds r JOIN round_entries e ON e.round_id = r.id
      WHERE r.account_id = $1 AND r.day < $2::date AND r.opened_at IS NOT NULL
      GROUP BY e.candidate_id
     UNION ALL
     SELECT other.account_id, false, true, NULL, false
       FROM conversation_participant mine
       JOIN conversation_participant other
         ON other.conversation_id = mine.conversation_id AND other.account_id <> mine.account_id
      WHERE mine.account_id = $1`,
    [ownerId, day, config.shown_cooldown_days, config.pass_cooldown_days],
  );
  const seen = new Map<string, { lastShown: string; passed: boolean }>();
  for (const row of rows) {
    if (row.last_shown !== null)
      seen.set(row.id, { lastShown: row.last_shown, passed: row.passed });
  }
  return {
    cooling: new Set(rows.filter((row) => row.shown).map((row) => row.id)),
    refused: new Set(rows.filter((row) => row.refused).map((row) => row.id)),
    seen,
  };
}

/**
 * The people whose like waits on the owner, those who sent a fish first
 * (#378), each group the oldest like first (#97): a
 * like of an ended day, so a decision the liker may still change is never
 * shown, within `like_expiry_days`, and not answered, by a decision of the
 * owner's on the liker on the like's day or after it. A like expired is
 * nobody's to see, and its sender is never told.
 */
async function waitingOn(
  db: Queryable,
  ownerId: string,
  day: string,
  config: BuilderConfig,
): Promise<{ id: string; fish: boolean; waived: Relaxation[] }[]> {
  // A like given on a relaxed card waives the liker's deal-breakers it came
  // in under for the owner (ADR-042 §7): asked as those fields set aside.
  const { rows } = await db.query<{ id: string; fish: boolean; waived: Relaxation["field"][] }>(
    `SELECT r.account_id AS id, bool_or(e.fish) AS fish,
            coalesce(array_agg(DISTINCT w.field) FILTER (WHERE w.field IS NOT NULL), '{}') AS waived
       FROM round_entries e JOIN rounds r ON r.id = e.round_id
       LEFT JOIN LATERAL unnest(e.relaxed_with) AS w(field) ON true
      WHERE e.candidate_id = $1 AND e.decision = 'like'
        AND r.day < $2::date AND r.day > $2::date - $3::int
        AND NOT EXISTS (
          SELECT 1 FROM rounds mine JOIN round_entries answer ON answer.round_id = mine.id
           WHERE mine.account_id = $1 AND answer.candidate_id = r.account_id
             AND answer.decision IS NOT NULL AND mine.day >= r.day)
      GROUP BY r.account_id
      ORDER BY bool_or(e.fish) DESC, min(e.decided_at), r.account_id`,
    [ownerId, day, config.like_expiry_days],
  );
  return rows.map((row) => ({
    ...row,
    waived: row.waived.map((field) => ({ field, kind: "aside" as const })),
  }));
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
  const waiting = (await waitingOn(db, owner.id, round.day, round.config)).filter(
    (like) => !history.refused.has(like.id),
  );
  const byId = new Map(shown.map((subject) => [subject.id, subject]));
  const fish = new Set(waiting.filter((like) => like.fish).map((like) => like.id));
  // shortcut: fish go first with no cap of their own, so a person sent more
  // fish than liked_you_cap for days sees no ordinary like, and those can
  // expire unseen (#97's comment of 20/10/2026, ADR-039); a row capping fish
  // per round lifts it, should it ever happen.
  // The round's places are bounded by the contract, whatever the panel sets
  // (ROUND_ENTRIES_MAX): the liked-you places first, the ordered ones after.
  // A shadow-banned person's round holds no liked-you or fish places, the
  // maintainer's of 21/10/2026 (ADR-037 §7): a like back would make no match
  // (ADR-038 §1), and so tell them of the ban (ADR-024 §7). Those likes wait
  // for the lift, their clock running, and their people are no ordinary
  // cards meanwhile.
  const likedYou = owner.visible
    ? likedYouPlaces(
        owner,
        waiting.flatMap((like) => {
          const liker = byId.get(like.id);
          return liker ? [{ ...liker, person: relaxedBy(liker.person, like.waived) }] : [];
        }),
        Math.min(round.config.liked_you_cap, ROUND_ENTRIES_MAX),
      )
    : [];
  const waits = new Set(waiting.map((like) => like.id));
  const ordered = orderedPlaces(
    owner,
    shown.filter(
      (subject) =>
        !history.refused.has(subject.id) &&
        !history.cooling.has(subject.id) &&
        !waits.has(subject.id),
    ),
    history,
    {
      day: round.day,
      size: Math.min(round.config.round_size, ROUND_ENTRIES_MAX - likedYou.length),
    },
  );
  return [
    ...likedYou.map((candidate) => ({
      candidateId: candidate.id,
      reason: fish.has(candidate.id) ? ("fish" as const) : ("liked_you" as const),
    })),
    ...ordered,
  ];
}

/**
 * The places no rule forces (ADR-042 §1): everybody new first, by their soft
 * matches; then, while room is left, people of earlier rounds past both
 * cooldowns, in the order they come back.
 */
function orderedPlaces(
  owner: Subject,
  candidates: readonly Subject[],
  history: History,
  round: { day: string; size: number },
): { candidateId: string; reason: "matches_filters" | "seen_before" }[] {
  const fresh = roundOrder(
    owner,
    candidates.filter((subject) => !history.seen.has(subject.id)),
    round,
  );
  const back = comingBackOrder(
    owner,
    candidates.flatMap((subject) => {
      const before = history.seen.get(subject.id);
      return before ? [{ ...subject, ...before }] : [];
    }),
    { day: round.day, size: round.size - fresh.length },
  );
  return [
    ...fresh.map((candidate) => ({
      candidateId: candidate.id,
      reason: "matches_filters" as const,
    })),
    ...back.map((candidate) => ({ candidateId: candidate.id, reason: "seen_before" as const })),
  ];
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
 * (ADR-035 §5). Whether a round for the day stands now, whoever wrote it: a
 * read beside it that built first leaves this one unwritten (`saveRound`
 * keeps the first), and the caller reads that round.
 */
export async function buildRoundOf(deps: BuilderDeps, accountId: string): Promise<boolean> {
  const at = deps.now();
  const day = finnishDay(at);
  const stands = async () =>
    (
      await deps.db.query("SELECT 1 FROM rounds WHERE account_id = $1 AND day = $2", [
        accountId,
        day,
      ])
    ).rows.length > 0;
  const { rows } = await deps.db.query<{ pond_id: string }>(
    `SELECT g.pond_id FROM gate g JOIN account a ON a.id = g.account_id AND a.pond_id = g.pond_id
      WHERE g.account_id = $1 AND g.opened_at IS NOT NULL
        AND a.state IN ('active', 'shadow_banned')`,
    [accountId],
  );
  const pondId = rows[0]?.pond_id;
  if (!pondId) return false;
  // Another read or the night built it since the caller looked: it stands.
  if (await stands()) return true;
  // The person alone first: one whose profile no longer counts as complete,
  // though their gate is open, costs no read of the pond on every visit.
  const me = await subjectOf(deps.db, pondId, accountId, at);
  if (!me?.openedAt) return false;
  const config = await matchingConfigNumbers(deps.db, KEYS);
  await buildPond(deps, pondId, { day, at, config }, accountId);
  // Built here, or by a read beside this one that wrote first (saveRound keeps
  // the first); false when the build failed (buildPond logged it), or when the
  // person was paused, sanctioned or erased between the look above and the
  // write (nothing to log).
  return stands();
}

/** The day's round of the person, with what the short pool reads of it, their pond and their history (ADR-042). */
async function todayOf(deps: BuilderDeps, accountId: string) {
  const at = deps.now();
  const day = finnishDay(at);
  const today = await relaxationsOf(deps.db, accountId, day);
  if (!today) return null;
  const { rows } = await deps.db.query<{ pond_id: string }>(
    `SELECT g.pond_id FROM gate g JOIN account a ON a.id = g.account_id AND a.pond_id = g.pond_id
      WHERE g.account_id = $1 AND g.opened_at IS NOT NULL
        AND a.state IN ('active', 'shadow_banned')`,
    [accountId],
  );
  const pondId = rows[0]?.pond_id;
  if (!pondId) return null;
  const subjects = await subjectsOfPond(deps.db, pondId, at);
  const owner = subjects.find((subject) => subject.id === accountId);
  if (!owner) return null;
  const config = await matchingConfigNumbers(deps.db, SHORT_POOL_KEYS);
  const history = await historyOf(deps.db, accountId, day, config);
  const placed = await deps.db.query<{ candidate_id: string }>(
    `SELECT e.candidate_id FROM round_entries e JOIN rounds r ON r.id = e.round_id
      WHERE r.account_id = $1 AND r.day = $2`,
    [accountId, day],
  );
  const inRound = new Set(placed.rows.map((row) => row.candidate_id));
  // Somebody whose like waits on the person is no ordinary card meanwhile, as in placesOf (ADR-037).
  const waits = new Set(
    (await waitingOn(deps.db, accountId, day, config))
      .filter((like) => !history.refused.has(like.id))
      .map((like) => like.id),
  );
  const shown = subjects.filter(
    (subject) => subject.visible && subject.admittedAt !== null && subject.id !== accountId,
  );
  // Whoever a relaxation may add today: the builder's own rules, today's cards aside.
  const open = shown.filter(
    (subject) =>
      !history.refused.has(subject.id) &&
      !history.cooling.has(subject.id) &&
      !inRound.has(subject.id) &&
      !waits.has(subject.id),
  );
  const effective = relaxedBy(owner.person, today.relaxed);
  return { day, owner, shown, open, history, today, config, effective };
}

/** Who a relaxation lets in: in each other's pool with it, and not without it (ADR-042 §3). */
const letsIn = (wider: PoolPerson, effective: PoolPerson) => (subject: Subject) =>
  inEachOthersPool(wider, subject.person) && !inEachOthersPool(effective, subject.person);

/**
 * What a short round may relax today (ADR-042 §4), counted now: each of the
 * person's own deal-breakers, not paused and not relaxed today, each way it
 * can be, with how much it widens the pool in the gate's steps, and listed
 * only when it would add somebody today. Null with no round today.
 */
export async function relaxationOffers(
  deps: BuilderDeps,
  accountId: string,
): Promise<{ short: boolean; offers: RelaxationOffer[] } | null> {
  const t = await todayOf(deps, accountId);
  if (!t) return null;
  // Short while the round gave fewer ordered places than round_size, an undone one counted (ADR-042 §2).
  const short = t.today.given < t.config.round_size && t.today.last < ROUND_ENTRIES_MAX;
  if (!short) return { short, offers: [] };
  const relaxed = new Set<string>(t.today.relaxed.map((r) => r.field));
  const offers: RelaxationOffer[] = [];
  for (const dealBreaker of t.effective.dealBreakers) {
    if (relaxed.has(dealBreaker.field) || pausedOf(dealBreaker.field, t.owner.person.fields)) {
      continue;
    }
    const kinds: RelaxationKind[] = dealBreaker.includeUnknown
      ? ["aside"]
      : ["unanswered", "aside"];
    for (const kind of kinds) {
      const wider = relaxedBy(t.effective, [{ field: dealBreaker.field, kind }]);
      const admits = letsIn(wider, t.effective);
      const adds = roundOrder({ ...t.owner, person: wider }, t.open.filter(admits), {
        day: t.day,
        size: 1,
      });
      if (adds.length === 0) continue;
      offers.push({
        field: dealBreaker.field,
        kind,
        // The gate's step, floored at its minimum, as every pool figure is said (ADR-015 §6).
        more: saidInStep(t.shown.filter(admits).length, waitlistK(t.config.waitlist_k)),
      });
    }
  }
  return { short, offers };
}

/**
 * Whom a relaxation lets in today, in the order they would come (ADR-042 §5):
 * new people first by their soft matches, then the order of coming back;
 * with the day's relaxations they were counted under, on top of which this
 * one loosens the person's filters.
 * Null for a relaxation the offers would not list: no round today, a field
 * that is no deal-breaker of the person's, a paused one, one relaxed today,
 * or `unanswered` where those people are let through already. The writer
 * takes as many as the room.
 */
export async function relaxedCandidates(
  deps: BuilderDeps,
  accountId: string,
  relaxation: Relaxation,
): Promise<{ basis: Relaxation[]; candidates: RelaxedCandidate[] } | null> {
  const t = await todayOf(deps, accountId);
  if (!t) return null;
  // The stored deal-breaker: one relaxed today meanwhile is the writer's to refuse, under the round's lock.
  const dealBreaker = t.owner.person.dealBreakers.find((d) => d.field === relaxation.field);
  if (!dealBreaker || pausedOf(dealBreaker.field, t.owner.person.fields)) return null;
  if (relaxation.kind === "unanswered" && dealBreaker.includeUnknown) return null;
  const wider = relaxedBy(t.effective, [relaxation]);
  const admitted = t.open.filter(letsIn(wider, t.effective));
  const byId = new Map(admitted.map((subject) => [subject.id, subject.person]));
  const all = [...t.today.relaxed, relaxation];
  // The day's other relaxations each one needs: those without which the person's filters still keep them out.
  const needsOf = (candidate: PoolPerson) =>
    t.today.relaxed
      .filter(
        (r) =>
          !inEachOthersPool(
            relaxedBy(
              t.owner.person,
              all.filter((other) => other.field !== r.field),
            ),
            candidate,
          ),
      )
      .map((r) => r.field);
  const candidates = orderedPlaces({ ...t.owner, person: wider }, admitted, t.history, {
    day: t.day,
    size: ROUND_ENTRIES_MAX,
  }).flatMap((place) => {
    const person = byId.get(place.candidateId);
    return person ? [{ candidateId: place.candidateId, needs: needsOf(person) }] : [];
  });
  return { basis: t.today.relaxed, candidates };
}

/** The nightly job: everybody's round for the day, after the gate has let people in. */
export function roundsJob(deps: BuilderDeps): NightlyJob {
  return { name: "round-builder", run: () => buildRounds(deps) };
}
