import { type Queryable, transaction } from "@kuutti/db";
import {
  type DealBreaker,
  type DealBreakerField,
  type ProfileCard,
  type Relaxation,
  type RelaxationOffer,
  type RelaxationsResponse,
  ROUND_ENTRIES_MAX,
  type RoundChoice,
  type RoundDecision,
  type RoundEntry,
  type RoundOrdering,
  type RoundReason,
  type RoundResponse,
  sinceSeenBand,
} from "@kuutti/schema";
import { AppError } from "../lib/errors.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import type { Logger } from "../lib/logger.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import { dayWindow, secondsUntil } from "../media/index.ts";
import { track } from "../research/index.ts";

// Today's round (#96, TD-11, TD-12, ADR-034): what one person is shown on one
// Finnish calendar day, each card with why it is there, when the phone
// reported it seen, and the person's own decision, which may change until the
// day ends (the maintainer, 19/10/2026). Every statement names the caller's
// own round (rule 6), and every one that writes asks, in itself, that the
// candidate is still live and that no block stands between the two (ADR-030
// §2): a block that commits meanwhile leaves nothing written. Raw parameterised
// SQL through Queryable, as the other slices: the round row's lock, the
// stored decision and the predicate all sit in the statements that write.

export type RoundDeps = { db: Queryable; logger: Logger; now: () => Date };

/** The card a person may be shown of another, or null where none may be: the profile slice's builder, handed in by app.ts. */
export type CardOf = (
  viewerAccountId: string,
  subjectAccountId: string,
) => Promise<ProfileCard | null>;

/**
 * Builds the person's round for today when they have none and their matching
 * has opened, and says whether a round for today stands now, whoever wrote
 * it: the round builder's (#95, ADR-035), which reads across slices and lives
 * with the jobs, handed in by app.ts.
 */
export type BuildToday = (accountId: string) => Promise<boolean>;

/**
 * What the chat slice keeps of a match (#100, ADR-031: the conversation is
 * its record), handed in by app.ts as the card builder is: whether two
 * people have a conversation, and the opening of one in the caller's
 * transaction.
 */
export type Matches = {
  between: (db: Queryable, accountId: string, otherAccountId: string) => Promise<string | null>;
  open: (tx: Queryable, input: { first: string; second: string; at: Date }) => Promise<string>;
};

/**
 * Two people's decisions about each other are taken one pair at a time
 * (#100, ADR-038): the second like reads the first, committed, and a like
 * is never taken back while another makes a match of it. A transaction-scoped
 * advisory lock on the pair, the same whichever of the two decides; taken
 * after the decider's round lock, never before, so no two wait for each
 * other. Two pairs whose keys collide wait for each other a moment, no more.
 */
const PAIR_LOCK = `SELECT pg_advisory_xact_lock(
  hashtextextended(least($1::text, $2::text) || greatest($1::text, $2::text), 100))`;

const LIKE_EXPIRY_KEY = "like_expiry_days";

/** An entry `e` of round `r` whose candidate can still be shown to the round's owner. */
const SERVABLE = `EXISTS (SELECT 1 FROM account c WHERE c.id = e.candidate_id AND c.state = 'active')
  AND NOT blocked_between(r.account_id, e.candidate_id)`;

const notFound = () => new AppError(404, "not_found", "No such card in today's round");

/**
 * The day's likes (#98's first cut, the maintainer's of 20/10/2026): one
 * budget for everybody, whatever their pond's contest (TD-14's two budgets
 * wait for the research partner). A like on the card of somebody who liked
 * the person answers a like rather than sending one, and is free; a pass is
 * never counted.
 */
const LIKE_BUDGET_KEY = "like_budget_balanced";
const FREE_LIKES: readonly RoundReason[] = ["liked_you", "fish"];

/**
 * The fish (#378, ADR-039, the maintainer's of 20/10/2026): a like with a
 * mark, `fish_budget` of them in any `fish_window_days`, rolling, counted
 * from the person's standing fish under the round's lock, so one changed
 * back the same day is given back. A fish is a like for every other rule:
 * the day's likes, the expiry, the match. On a card of somebody whose like or
 * fish waits on the person it would answer a like, and is a like.
 */
const FISH_BUDGET_KEY = "fish_budget";
const FISH_WINDOW_KEY = "fish_window_days";

/** A Finnish day `days` after another, both as YYYY-MM-DD. */
function addDays(day: string, days: number): string {
  const at = new Date(`${day}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** What a person reads back of their own decision: a like with the mark is a fish. */
const choiceOf = (decision: RoundDecision | null, fish: boolean): RoundChoice | null =>
  decision === "like" && fish ? "fish" : decision;

/**
 * A new round, the round builder's (#95) one writer: the round and its
 * entries in one transaction, then `round_built`. A round already built for
 * the account and day is left as it was (null). Places start at 1; a
 * candidate is never the owner and never twice in one round. Each statement
 * asks for itself, holding the rows FOR SHARE, that the owner is still
 * active or shadow-banned (not paused, sanctioned or erased) and that each
 * candidate is still active with no block between the two: the builder reads
 * the pool before it writes, and a pause, a sanction, an erasure or a block
 * in between must not leave a row that outlives it. A candidate dropped so
 * leaves its place empty, as the read does.
 */
export async function saveRound(
  deps: RoundDeps,
  input: {
    accountId: string;
    day: string;
    /** How the places no rule forces were ordered, for `round_built` (#95). */
    ordering: RoundOrdering;
    entries: { candidateId: string; reason: RoundReason }[];
  },
): Promise<{ roundId: string } | null> {
  if (input.entries.some((entry) => entry.candidateId === input.accountId)) {
    throw new Error("saveRound: a person is never a card in their own round");
  }
  const builtAt = deps.now();
  const saved = await transaction(deps.db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO rounds (account_id, day, built_at, last_position)
       SELECT id, $2, $3, $4 FROM account WHERE id = $1 AND state IN ('active', 'shadow_banned') FOR SHARE
       ON CONFLICT (account_id, day) DO NOTHING RETURNING id`,
      // The places are the entries' order: the highest a dropped candidate leaves empty is still given.
      [input.accountId, input.day, builtAt, input.entries.length],
    );
    const id = rows[0]?.id;
    if (!id) return null;
    if (input.entries.length > 0) {
      const written = await tx.query<{ reason: RoundReason }>(
        `INSERT INTO round_entries (round_id, position, candidate_id, reason)
         SELECT $1, e.ordinality, e.candidate, e.reason::round_reason
           FROM unnest($2::uuid[], $3::text[]) WITH ORDINALITY AS e(candidate, reason, ordinality)
           JOIN account c ON c.id = e.candidate
          WHERE c.state = 'active' AND NOT blocked_between($4, e.candidate)
          FOR SHARE OF c
         RETURNING reason`,
        [
          id,
          input.entries.map((e) => e.candidateId),
          input.entries.map((e) => e.reason),
          input.accountId,
        ],
      );
      return { id, reasons: written.rows.map((row) => row.reason) };
    }
    return { id, reasons: [] };
  });
  if (!saved) return null;
  // What was written, a dropped candidate left out.
  const count = (reason: RoundReason) => saved.reasons.filter((r) => r === reason).length;
  await track({ ...deps, now: () => builtAt }, input.accountId, "round_built", {
    ordering: input.ordering,
    size: saved.reasons.length,
    matchesFilters: count("matches_filters"),
    likedYou: count("liked_you"),
    seenBefore: count("seen_before"),
    relaxed: count("relaxed"),
    fish: count("fish"),
  });
  return { roundId: saved.id };
}

/** A row of a round's entry as the read takes it. */
type EntryRow = {
  position: number | null;
  candidate_id: string | null;
  reason: RoundReason | null;
  decision: RoundDecision | null;
  fish: boolean | null;
  relaxed_field: DealBreakerField | null;
};

/**
 * The entries' cards in order, each through the card builder, which writes
 * the shown record and counts the day's cards (ADR-008); a card it refuses (a
 * block either way, a sanction, a profile no longer complete) is left out.
 * Each says which of the person's own deal-breakers, not paused, its person
 * left unanswered (ADR-042 §8): every deal-breaker field is a card field, and
 * the card leaves an unanswered one out.
 */
async function entriesOf(
  accountId: string,
  rows: readonly EntryRow[],
  cardOf: CardOf,
  dealBreakers: readonly DealBreaker[],
): Promise<RoundEntry[]> {
  const entries: RoundEntry[] = [];
  for (const row of rows) {
    if (row.position === null || row.candidate_id === null || row.reason === null) continue;
    const card = await cardOf(accountId, row.candidate_id);
    if (!card) continue;
    entries.push({
      position: row.position,
      reason: row.reason,
      decision: choiceOf(row.decision, row.fish === true),
      card,
      ...(row.relaxed_field ? { relaxedField: row.relaxed_field } : {}),
      notAnswered: dealBreakers
        .filter((dealBreaker) => card.fields[dealBreaker.field] === undefined)
        .map((dealBreaker) => dealBreaker.field),
    });
  }
  return entries;
}

/**
 * Today's round as the person opens it: its cards in order (`entriesOf`).
 * Null entries before the round is built. The first read that finds the
 * round stamps `opened_at`. `dealBreakers` are the person's own, not paused.
 */
export async function readTodaysRound(
  deps: RoundDeps,
  accountId: string,
  cardOf: CardOf,
  dealBreakers: readonly DealBreaker[] = [],
): Promise<RoundResponse> {
  const at = deps.now();
  const day = finnishDay(at);
  const { rows } = await deps.db.query<EntryRow & { id: string }>(
    `SELECT r.id, e.position, e.candidate_id, e.reason, e.decision, e.fish, e.relaxed_field
       FROM rounds r LEFT JOIN round_entries e ON e.round_id = r.id
      WHERE r.account_id = $1 AND r.day = $2
      ORDER BY e.position`,
    [accountId, day],
  );
  const round = rows[0];
  if (!round) return { day, entries: null };
  await deps.db.query(
    "UPDATE rounds SET opened_at = $3 WHERE id = $1 AND account_id = $2 AND opened_at IS NULL",
    [round.id, accountId, at],
  );
  return { day, entries: await entriesOf(accountId, rows, cardOf, dealBreakers) };
}

/** The day named, checked against today before anything is read: an ended day's round answers round_expired, a later one is nobody's yet. */
function todayOrRefuse(deps: RoundDeps, day: string): { at: Date; today: string } {
  const at = deps.now();
  const today = finnishDay(at);
  if (day < today) {
    throw new AppError(409, "round_expired", "That round ended with its day");
  }
  if (day > today) throw notFound();
  return { at, today };
}

/**
 * The phone's report that a card was on the screen: the first sets
 * `seen_at` and emits `profile_viewed`; a repeat writes nothing. A decision
 * never needs it and never writes it.
 */
export async function markSeen(
  deps: RoundDeps,
  input: { accountId: string; day: string; position: number },
): Promise<void> {
  const { at, today } = todayOrRefuse(deps, input.day);
  const marked = await deps.db.query<{ reason: RoundReason }>(
    `UPDATE round_entries e SET seen_at = $4
       FROM rounds r
      WHERE r.id = e.round_id AND r.account_id = $1 AND r.day = $2 AND e.position = $3
        AND e.seen_at IS NULL AND ${SERVABLE}
      RETURNING e.reason`,
    [input.accountId, today, input.position, at],
  );
  const reason = marked.rows[0]?.reason;
  if (reason) {
    await track({ ...deps, now: () => at }, input.accountId, "profile_viewed", {
      position: input.position,
      reason,
    });
    return;
  }
  // Seen before, or not there at all: told apart only to answer 404.
  const { rows } = await deps.db.query(
    `SELECT 1 FROM round_entries e JOIN rounds r ON r.id = e.round_id
      WHERE r.account_id = $1 AND r.day = $2 AND e.position = $3 AND ${SERVABLE}`,
    [input.accountId, today, input.position],
  );
  if (rows.length === 0) throw notFound();
}

/**
 * A like or a pass on today's card, changeable until the day ends: under the
 * round row's lock, which serialises the person's day across devices and
 * which the day's likes are counted under. The same decision again writes
 * nothing; a changed one emits its event with `revised`. The round is
 * complete once nothing that can still be shown is undecided.
 *
 * A like of somebody whose like of the person stands, within
 * `like_expiry_days`, is a match (#100, ADR-038): the conversation is opened
 * in this transaction, under the pair's lock, and the answer names it. A like
 * that is part of a match is final, the maintainer's of 20/10/2026: it is
 * not changed, and its place in the day's likes stays spent; any other like
 * may still be taken back until midnight. No match is made while the person
 * is shadow-banned, nor with a block between the two.
 */
export async function decide(
  deps: RoundDeps,
  matches: Matches,
  input: { accountId: string; day: string; position: number; decision: RoundChoice },
): Promise<{ match: string | null }> {
  const { at, today } = todayOrRefuse(deps, input.day);
  const decision: RoundDecision = input.decision === "pass" ? "pass" : "like";
  const written = await transaction(deps.db, async (tx) => {
    // The two accounts first, shared and in id order, before any row of a
    // round: erasure and a sanction take an account FOR UPDATE before they
    // touch rounds or conversations, so one under way finishes before this
    // decision reads, and one that comes later waits for it to commit; an
    // erasure or a ban then closes the match it opened, and a warning, a
    // shadow ban or a suspension leaves it as it leaves every conversation
    // (ADR-024, ADR-031 §2). Taken after the round, they deadlocked with an
    // erasure, and a sanction could slip a match past its own check (ADR-038 §2).
    const card = await tx.query<{ candidate_id: string }>(
      `SELECT e.candidate_id FROM round_entries e JOIN rounds r ON r.id = e.round_id
        WHERE r.account_id = $1 AND r.day = $2 AND e.position = $3`,
      [input.accountId, today, input.position],
    );
    const candidateId = card.rows[0]?.candidate_id;
    if (!candidateId) throw notFound();
    await tx.query("SELECT 1 FROM account WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE", [
      [input.accountId, candidateId],
    ]);
    const round = await tx.query<{ id: string }>(
      "SELECT id FROM rounds WHERE account_id = $1 AND day = $2 FOR UPDATE",
      [input.accountId, today],
    );
    const roundId = round.rows[0]?.id;
    if (!roundId) throw notFound();
    const found = await tx.query<{
      id: string;
      candidate_id: string;
      reason: RoundReason;
      seen_at: Date | null;
      decision: RoundDecision | null;
      fish: boolean;
    }>(
      `SELECT e.id, e.candidate_id, e.reason, e.seen_at, e.decision, e.fish
         FROM round_entries e JOIN rounds r ON r.id = e.round_id
        WHERE r.id = $1 AND r.account_id = $2 AND e.position = $3 AND ${SERVABLE}`,
      [roundId, input.accountId, input.position],
    );
    const entry = found.rows[0];
    if (!entry) throw notFound();
    // A fish on a card that answers a like is a like (ADR-039 §2).
    const fish = input.decision === "fish" && !FREE_LIKES.includes(entry.reason);
    await tx.query(PAIR_LOCK, [input.accountId, entry.candidate_id]);
    const standing = await matches.between(tx, input.accountId, entry.candidate_id);
    if (entry.decision === decision && entry.fish === fish) {
      return { match: decision === "like" ? standing : null, decided: null };
    }
    if (standing && entry.decision === "like") {
      throw new AppError(409, "match_made", "This like made a match and stays");
    }
    // Counted under the round's lock from the day's standing decisions, so a
    // like taken back gives its place back and two devices cannot both pass
    // the count; the refusal writes nothing. A like made a fish was counted.
    if (decision === "like" && entry.decision !== "like" && !FREE_LIKES.includes(entry.reason)) {
      const budget = await matchingConfigNumber(tx, LIKE_BUDGET_KEY);
      const liked = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM round_entries
          WHERE round_id = $1 AND decision = 'like' AND reason <> ALL($2::round_reason[])`,
        [roundId, FREE_LIKES],
      );
      if ((liked.rows[0]?.n ?? 0) >= budget) {
        throw new AppError(429, "like_budget_exceeded", "The day's likes are used up", {
          retryAfterSeconds: secondsUntil(dayWindow(at).end, at),
        });
      }
    }
    // The person's fish of the last fish_window_days, this card's aside, under
    // the round's lock; the next comes back when the oldest leaves the window.
    if (fish && !entry.fish) {
      const budget = await matchingConfigNumber(tx, FISH_BUDGET_KEY);
      const window = await matchingConfigNumber(tx, FISH_WINDOW_KEY);
      const sent = await tx.query<{ n: number; oldest: string | null }>(
        `SELECT count(*)::int AS n, min(r.day)::text AS oldest
           FROM round_entries e JOIN rounds r ON r.id = e.round_id
          WHERE r.account_id = $1 AND e.fish AND e.id <> $2 AND r.day > $3::date - $4::int`,
        [input.accountId, entry.id, today, window],
      );
      const [row] = sent.rows;
      if (row && row.n >= budget) {
        // With a budget of none there is no oldest, and nothing before the day rolls.
        const back = row.oldest
          ? dayWindow(new Date(`${addDays(row.oldest, window)}T12:00:00Z`)).start
          : dayWindow(at).end;
        throw new AppError(429, "fish_budget_exceeded", "The window's fish are sent", {
          retryAfterSeconds: secondsUntil(back, at),
        });
      }
    }
    // The predicate again where it writes: a block or an erasure that
    // committed since the read leaves nothing written.
    const updated = await tx.query(
      `UPDATE round_entries e SET decision = $4, decided_at = $5, fish = $6
         FROM rounds r
        WHERE r.id = e.round_id AND r.id = $1 AND r.account_id = $2 AND e.id = $3 AND ${SERVABLE}`,
      [roundId, input.accountId, entry.id, decision, at, fish],
    );
    if (updated.rowCount !== 1) throw notFound();
    await tx.query(
      `UPDATE rounds r SET completed_at = $3
        WHERE r.id = $1 AND r.account_id = $2 AND r.completed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM round_entries e
                           WHERE e.round_id = r.id AND e.decision IS NULL AND ${SERVABLE})`,
      [roundId, input.accountId, at],
    );
    let match = decision === "like" ? standing : null;
    let opened = false;
    if (decision === "like" && !standing) {
      // The other's like of the person, still standing and not expired, today's
      // included: under the pair's lock it is committed or it is not there.
      const mutual = await tx.query(
        `SELECT 1 FROM round_entries e JOIN rounds r ON r.id = e.round_id
          WHERE r.account_id = $1 AND e.candidate_id = $2 AND e.decision = 'like'
            AND r.day > $3::date - $4::int
            AND EXISTS (SELECT 1 FROM account me WHERE me.id = $2 AND me.state = 'active')
            AND NOT blocked_between($2, $1)
          LIMIT 1`,
        [
          entry.candidate_id,
          input.accountId,
          today,
          await matchingConfigNumber(tx, LIKE_EXPIRY_KEY),
        ],
      );
      if (mutual.rows.length > 0) {
        match = await matches.open(tx, {
          first: entry.candidate_id,
          second: input.accountId,
          at,
        });
        opened = true;
      }
    }
    return {
      match,
      decided: {
        reason: entry.reason,
        seenAt: entry.seen_at,
        revised: entry.decision !== null,
        candidateId: entry.candidate_id,
        opened,
        fish,
      },
    };
  });
  const decided = written.decided;
  if (decided) {
    const now = () => at;
    const props = {
      position: input.position,
      reason: decided.reason,
      sinceSeen: decided.seenAt ? sinceSeenBand(at.getTime() - decided.seenAt.getTime()) : null,
      revised: decided.revised,
    };
    if (decision === "like") {
      await track({ ...deps, now }, input.accountId, "like", { ...props, fish: decided.fish });
    } else {
      await track({ ...deps, now }, input.accountId, "pass", props);
    }
    if (decided.opened) {
      await track({ ...deps, now }, input.accountId, "match", { completed: true });
      await track({ ...deps, now }, decided.candidateId, "match", { completed: false });
    }
  }
  return { match: written.match };
}

/**
 * The short pool's side that reads across slices (#99, ADR-042 §4, §5): the
 * round builder's, which lives with the jobs and reads the pond as it does,
 * handed in by app.ts. `offers` is what a short round may relax today, null
 * with no round today; `candidates` whom a relaxation lets in today, in the
 * order they would come, null for one the offers would not list.
 */
/** Somebody a relaxation lets in, with the day's other relaxations their filters still need (ADR-042 §5). */
export type RelaxedCandidate = { candidateId: string; needs: DealBreakerField[] };

export type ShortPool = {
  offers: (accountId: string) => Promise<{ short: boolean; offers: RelaxationOffer[] } | null>;
  /**
   * With the day's relaxations the candidates were counted under (`basis`),
   * which the writer holds them to, and for each the ones of them it needs.
   */
  candidates: (
    accountId: string,
    relaxation: Relaxation,
  ) => Promise<{ basis: Relaxation[]; candidates: RelaxedCandidate[] } | null>;
};

/**
 * The places of a round `r`: the highest it ever gave (`last_position`, or the
 * highest entry of a round written before it was kept), and of those the
 * ordered ones, every place but the liked-you and fish places, which nothing
 * undoes. A place an undo freed stays given (ADR-042 §5), so a day's round
 * holds at most `round_size` ordered people, as ADR-041's bound on a day's
 * cards reads it.
 */
const PLACES = `greatest(r.last_position,
           coalesce((SELECT max(e.position) FROM round_entries e WHERE e.round_id = r.id), 0))::int`;
const GIVEN = `(${PLACES} - (SELECT count(*) FROM round_entries e
                 WHERE e.round_id = r.id AND e.reason = ANY($3::round_reason[]))::int)`;

/**
 * Today's relaxations of the person's round (ADR-042 §3), the highest place it
 * gave, and how many ordered places it gave; null with no round for the day.
 */
export async function relaxationsOf(
  db: Queryable,
  accountId: string,
  day: string,
): Promise<{ last: number; given: number; relaxed: Relaxation[] } | null> {
  const { rows } = await db.query<{ last: number; given: number; relaxed: Relaxation[] }>(
    `SELECT ${PLACES} AS last, ${GIVEN} AS given,
            coalesce((SELECT json_agg(json_build_object('field', x.field, 'kind', x.kind)
                                      ORDER BY x.field)
                        FROM round_relaxation x WHERE x.round_id = r.id), '[]') AS relaxed
       FROM rounds r WHERE r.account_id = $1 AND r.day = $2`,
    [accountId, day, FREE_LIKES],
  );
  return rows[0] ?? null;
}

const ROUND_SIZE_KEY = "round_size";

/** The same relaxations, whatever their order. */
const sameRelaxations = (a: readonly Relaxation[], b: readonly Relaxation[]) => {
  const key = (r: Relaxation) => `${r.field}:${r.kind}`;
  return JSON.stringify(a.map(key).sort()) === JSON.stringify(b.map(key).sort());
};

/**
 * A relaxation tapped (ADR-042 §5): recorded on today's round, and the people
 * it lets in added after the highest place the round ever gave
 * (`last_position`, so a place an undo freed never names somebody else), as
 * many as the room left (`round_size` less the ordered places the round ever
 * gave, so an undo gives no room back), in the order given, reason `relaxed`
 * with the field, and with the relaxations of the day each needs (`relaxed_with`,
 * the tapped one first), so undoing one of them takes the card back and a
 * like waives them all. Under the round's
 * lock, after the owner's account shared as a decision takes it; the day's
 * relaxations are held to those the candidates were counted under (`basis`),
 * so one undone or made meanwhile refuses the write, 409
 * `relaxations_changed`; each candidate is asked where it is written to be
 * still active, with no block between the two, and not in the round yet.
 * `completed_at` is cleared when a place is added. The places written, in
 * order; 409 `already_relaxed` for a field relaxed today, nothing written.
 */
export async function appendRelaxed(
  deps: RoundDeps,
  input: {
    accountId: string;
    day: string;
    relaxation: Relaxation;
    basis: readonly Relaxation[];
    candidates: readonly RelaxedCandidate[];
  },
): Promise<number[]> {
  const { today } = todayOrRefuse(deps, input.day);
  return transaction(deps.db, async (tx) => {
    await tx.query("SELECT 1 FROM account WHERE id = $1 FOR SHARE", [input.accountId]);
    const round = await tx.query<{ id: string }>(
      "SELECT id FROM rounds WHERE account_id = $1 AND day = $2 FOR UPDATE",
      [input.accountId, today],
    );
    const roundId = round.rows[0]?.id;
    if (!roundId) throw noRound();
    const standing = await tx.query<Relaxation>(
      "SELECT field, kind FROM round_relaxation WHERE round_id = $1",
      [roundId],
    );
    if (standing.rows.some((r) => r.field === input.relaxation.field)) {
      throw new AppError(409, "already_relaxed", "That deal-breaker is relaxed today");
    }
    if (!sameRelaxations(standing.rows, input.basis)) {
      throw new AppError(409, "relaxations_changed", "The day's relaxations changed meanwhile");
    }
    // Read under the round's lock above, so the same field cannot have come in meanwhile.
    await tx.query(
      "INSERT INTO round_relaxation (round_id, field, kind, created_at) VALUES ($1, $2, $3, $4)",
      [roundId, input.relaxation.field, input.relaxation.kind, deps.now()],
    );
    const size = await matchingConfigNumber(tx, ROUND_SIZE_KEY);
    const placed = await tx.query<{ last: number; given: number }>(
      `SELECT ${PLACES} AS last, ${GIVEN} AS given FROM rounds r WHERE r.id = $1 AND r.account_id = $2`,
      [roundId, input.accountId, FREE_LIKES],
    );
    const { last = 0, given = 0 } = placed.rows[0] ?? {};
    const room = Math.min(size - given, ROUND_ENTRIES_MAX - last);
    if (room <= 0 || input.candidates.length === 0) return [];
    const taken = await tx.query<{ candidate: string }>(
      `SELECT e.candidate FROM unnest($1::uuid[]) WITH ORDINALITY AS e(candidate, ordinality)
         JOIN account c ON c.id = e.candidate
        WHERE c.state = 'active' AND NOT blocked_between($2, e.candidate)
          AND NOT EXISTS (SELECT 1 FROM round_entries x WHERE x.round_id = $3 AND x.candidate_id = e.candidate)
          AND e.candidate <> $2
        ORDER BY e.ordinality LIMIT $4
        FOR SHARE OF c`,
      [input.candidates.map((c) => c.candidateId), input.accountId, roundId, room],
    );
    const positions = taken.rows.map((_, index) => last + index + 1);
    if (positions.length === 0) return [];
    const needs = new Map(input.candidates.map((c) => [c.candidateId, c.needs]));
    await tx.query(
      `INSERT INTO round_entries (round_id, position, candidate_id, reason, relaxed_field, relaxed_with)
       SELECT $1, e.position, e.candidate, 'relaxed', $4, string_to_array(e.relaxed_with, ',')
         FROM unnest($2::smallint[], $3::uuid[], $5::text[]) AS e(position, candidate, relaxed_with)`,
      [
        roundId,
        positions,
        taken.rows.map((row) => row.candidate),
        input.relaxation.field,
        // Field keys hold no comma: each card's relaxations as one text, the tapped one first.
        taken.rows.map((row) =>
          [input.relaxation.field, ...(needs.get(row.candidate) ?? [])].join(","),
        ),
      ],
    );
    await tx.query(
      `UPDATE rounds SET completed_at = NULL, last_position = $3
        WHERE id = $1 AND account_id = $2`,
      [roundId, input.accountId, last + positions.length],
    );
    return positions;
  });
}

/**
 * A relaxation undone (ADR-042 §6): its row deleted, and with it today's
 * cards that need it and are still undecided, a later relaxation's that
 * needed it too, under the round's lock; a decided one stays. The round is
 * complete again, when the person decided on something, once nothing that
 * can still be shown is undecided. The places removed; 404 for a field not
 * relaxed today.
 */
export async function undoRelaxation(
  deps: RoundDeps,
  input: { accountId: string; day: string; field: DealBreakerField },
): Promise<number[]> {
  const { at, today } = todayOrRefuse(deps, input.day);
  return transaction(deps.db, async (tx) => {
    await tx.query("SELECT 1 FROM account WHERE id = $1 FOR SHARE", [input.accountId]);
    const round = await tx.query<{ id: string }>(
      "SELECT id FROM rounds WHERE account_id = $1 AND day = $2 FOR UPDATE",
      [input.accountId, today],
    );
    const roundId = round.rows[0]?.id;
    if (!roundId) throw noRound();
    const undone = await tx.query(
      "DELETE FROM round_relaxation WHERE round_id = $1 AND field = $2",
      [roundId, input.field],
    );
    if (undone.rowCount !== 1) throw new AppError(404, "not_found", "Not relaxed today");
    const removed = await tx.query<{ position: number }>(
      `DELETE FROM round_entries WHERE round_id = $1 AND $2 = ANY(relaxed_with) AND decision IS NULL
       RETURNING position`,
      [roundId, input.field],
    );
    await tx.query(
      `UPDATE rounds r SET completed_at = $3
        WHERE r.id = $1 AND r.account_id = $2 AND r.completed_at IS NULL
          AND EXISTS (SELECT 1 FROM round_entries e
                       WHERE e.round_id = r.id AND e.decision IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM round_entries e
                           WHERE e.round_id = r.id AND e.decision IS NULL AND ${SERVABLE})`,
      [roundId, input.accountId, at],
    );
    return removed.rows.map((row) => row.position).sort((a, b) => a - b);
  });
}

const noRound = () => new AppError(404, "not_found", "No round today");

/**
 * What the person may relax today and what they have (ADR-042 §4), for the
 * day named: an ended day answers round_expired, a day with no round 404.
 */
export async function readRelaxations(
  deps: RoundDeps,
  shortPool: ShortPool,
  input: { accountId: string; day: string },
): Promise<RelaxationsResponse> {
  const { today } = todayOrRefuse(deps, input.day);
  const now = await relaxationsOf(deps.db, input.accountId, today);
  if (!now) throw noRound();
  const offered = await shortPool.offers(input.accountId);
  return { short: offered?.short ?? false, offers: offered?.offers ?? [], relaxed: now.relaxed };
}

/**
 * A relaxation tapped (ADR-042 §5): 409 `already_relaxed` for a field relaxed
 * today, 404 for one the offers would not list; otherwise the people it lets
 * in, added (`appendRelaxed`). The places written.
 */
export async function relax(
  deps: RoundDeps,
  shortPool: ShortPool,
  input: { accountId: string; day: string; relaxation: Relaxation },
): Promise<number[]> {
  const { today } = todayOrRefuse(deps, input.day);
  const now = await relaxationsOf(deps.db, input.accountId, today);
  if (!now) throw noRound();
  if (now.relaxed.some((r) => r.field === input.relaxation.field)) {
    throw new AppError(409, "already_relaxed", "That deal-breaker is relaxed today");
  }
  const found = await shortPool.candidates(input.accountId, input.relaxation);
  if (!found) throw new AppError(404, "not_found", "No such relaxation to offer");
  return appendRelaxed(deps, { ...input, day: today, ...found });
}

/** The cards at these places of today's round, as the read gives them (`entriesOf`), for the answer of a relaxation. */
export async function readAdded(
  deps: RoundDeps,
  accountId: string,
  day: string,
  positions: readonly number[],
  cardOf: CardOf,
  dealBreakers: readonly DealBreaker[],
): Promise<RoundEntry[]> {
  if (positions.length === 0) return [];
  const { rows } = await deps.db.query<EntryRow>(
    `SELECT e.position, e.candidate_id, e.reason, e.decision, e.fish, e.relaxed_field
       FROM round_entries e JOIN rounds r ON r.id = e.round_id
      WHERE r.account_id = $1 AND r.day = $2 AND e.position = ANY($3::smallint[])
      ORDER BY e.position`,
    [accountId, day, positions],
  );
  return entriesOf(accountId, rows, cardOf, dealBreakers);
}

/**
 * Erasure's part (TD-7, ADR-007 §4), inside its transaction: the entries in
 * which the person is somebody's card, others' decisions on them included,
 * and the person's own rounds, their entries with them.
 */
export async function eraseRoundsOf(
  tx: Queryable,
  accountId: string,
): Promise<{ rounds: number; entriesAsCandidate: number }> {
  const asCandidate = await tx.query("DELETE FROM round_entries WHERE candidate_id = $1", [
    accountId,
  ]);
  const own = await tx.query("DELETE FROM rounds WHERE account_id = $1", [accountId]);
  return { rounds: own.rowCount ?? 0, entriesAsCandidate: asCandidate.rowCount ?? 0 };
}

export type OwnRound = {
  day: string;
  builtAt: Date;
  openedAt: Date | null;
  completedAt: Date | null;
  /** The day's relaxations (ADR-042 §10), the oldest first. */
  relaxations: { field: DealBreakerField; kind: Relaxation["kind"]; createdAt: Date }[];
  entries: {
    position: number;
    reason: RoundReason;
    relaxedField: DealBreakerField | null;
    seenAt: Date | null;
    decision: RoundChoice | null;
    decidedAt: Date | null;
  }[];
};

/** The person's own rounds for their export, newest day first: places, reasons and decisions, never whom. */
export async function exportRounds(
  db: Queryable,
  accountId: string,
  limit: number,
): Promise<OwnRound[]> {
  const { rows } = await db.query<{
    id: string;
    day: string;
    built_at: Date;
    opened_at: Date | null;
    completed_at: Date | null;
  }>(
    `SELECT id, day::text AS day, built_at, opened_at, completed_at FROM rounds
      WHERE account_id = $1 ORDER BY day DESC LIMIT $2`,
    [accountId, limit],
  );
  if (rows.length === 0) return [];
  const entries = await db.query<{
    round_id: string;
    position: number;
    reason: RoundReason;
    relaxed_field: DealBreakerField | null;
    seen_at: Date | null;
    decision: RoundDecision | null;
    fish: boolean;
    decided_at: Date | null;
  }>(
    `SELECT e.round_id, e.position, e.reason, e.relaxed_field, e.seen_at, e.decision, e.fish, e.decided_at
       FROM round_entries e JOIN rounds r ON r.id = e.round_id
      WHERE r.account_id = $1 AND r.id = ANY($2::uuid[])
      ORDER BY e.position`,
    [accountId, rows.map((row) => row.id)],
  );
  const relaxations = await db.query<{
    round_id: string;
    field: DealBreakerField;
    kind: Relaxation["kind"];
    created_at: Date;
  }>(
    `SELECT x.round_id, x.field, x.kind, x.created_at
       FROM round_relaxation x JOIN rounds r ON r.id = x.round_id
      WHERE r.account_id = $1 AND r.id = ANY($2::uuid[])
      ORDER BY x.created_at, x.field`,
    [accountId, rows.map((row) => row.id)],
  );
  return rows.map((row) => ({
    day: row.day,
    builtAt: row.built_at,
    openedAt: row.opened_at,
    completedAt: row.completed_at,
    relaxations: relaxations.rows
      .filter((relaxation) => relaxation.round_id === row.id)
      .map((relaxation) => ({
        field: relaxation.field,
        kind: relaxation.kind,
        createdAt: relaxation.created_at,
      })),
    entries: entries.rows
      .filter((entry) => entry.round_id === row.id)
      .map((entry) => ({
        position: entry.position,
        reason: entry.reason,
        relaxedField: entry.relaxed_field,
        seenAt: entry.seen_at,
        decision: choiceOf(entry.decision, entry.fish),
        decidedAt: entry.decided_at,
      })),
  }));
}
