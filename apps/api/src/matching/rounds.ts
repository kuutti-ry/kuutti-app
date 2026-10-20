import { type Queryable, transaction } from "@kuutti/db";
import {
  type ProfileCard,
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
 * has opened, and says whether it built one: the round builder's (#95,
 * ADR-035), which reads across slices and lives with the jobs, handed in by
 * app.ts.
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
const FREE_LIKES: readonly RoundReason[] = ["liked_you"];

/**
 * A new round, the round builder's (#95) one writer: the round and its
 * entries in one transaction, then `round_built`. A round already built for
 * the account and day is left as it was (null). Places start at 1; a
 * candidate is never the owner and never twice in one round. Each statement
 * asks for itself, holding the rows FOR SHARE, that the owner is not erased
 * and that each candidate is still active with no block between the two:
 * the builder reads the pool before it writes, and an erasure or a block in
 * between must not leave a row that outlives it. A candidate dropped so
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
      `INSERT INTO rounds (account_id, day, built_at)
       SELECT id, $2, $3 FROM account WHERE id = $1 AND state <> 'deleted' FOR SHARE
       ON CONFLICT (account_id, day) DO NOTHING RETURNING id`,
      [input.accountId, input.day, builtAt],
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
  });
  return { roundId: saved.id };
}

/**
 * Today's round as the person opens it: its cards in order, each through the
 * card builder, which writes the shown record and counts the day's cards
 * (ADR-008); a card it refuses (a block either way, a sanction, a profile no
 * longer complete) is left out. Null entries before the round is built. The
 * first read that finds the round stamps `opened_at`.
 */
export async function readTodaysRound(
  deps: RoundDeps,
  accountId: string,
  cardOf: CardOf,
): Promise<RoundResponse> {
  const at = deps.now();
  const day = finnishDay(at);
  const { rows } = await deps.db.query<{
    id: string;
    position: number | null;
    candidate_id: string | null;
    reason: RoundReason | null;
    decision: RoundDecision | null;
  }>(
    `SELECT r.id, e.position, e.candidate_id, e.reason, e.decision
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
  const entries: RoundEntry[] = [];
  for (const row of rows) {
    if (row.position === null || row.candidate_id === null || row.reason === null) continue;
    const card = await cardOf(accountId, row.candidate_id);
    if (!card) continue;
    entries.push({ position: row.position, reason: row.reason, decision: row.decision, card });
  }
  return { day, entries };
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
  input: { accountId: string; day: string; position: number; decision: RoundDecision },
): Promise<{ match: string | null }> {
  const { at, today } = todayOrRefuse(deps, input.day);
  const written = await transaction(deps.db, async (tx) => {
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
    }>(
      `SELECT e.id, e.candidate_id, e.reason, e.seen_at, e.decision
         FROM round_entries e JOIN rounds r ON r.id = e.round_id
        WHERE r.id = $1 AND r.account_id = $2 AND e.position = $3 AND ${SERVABLE}`,
      [roundId, input.accountId, input.position],
    );
    const entry = found.rows[0];
    if (!entry) throw notFound();
    await tx.query(PAIR_LOCK, [input.accountId, entry.candidate_id]);
    const standing = await matches.between(tx, input.accountId, entry.candidate_id);
    if (entry.decision === input.decision) {
      return { match: input.decision === "like" ? standing : null, decided: null };
    }
    if (standing && entry.decision === "like") {
      throw new AppError(409, "match_made", "This like made a match and stays");
    }
    // Counted under the round's lock from the day's standing decisions, so a
    // like taken back gives its place back and two devices cannot both pass
    // the count; the refusal writes nothing.
    if (input.decision === "like" && !FREE_LIKES.includes(entry.reason)) {
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
    // The predicate again where it writes: a block or an erasure that
    // committed since the read leaves nothing written.
    const updated = await tx.query(
      `UPDATE round_entries e SET decision = $4, decided_at = $5
         FROM rounds r
        WHERE r.id = e.round_id AND r.id = $1 AND r.account_id = $2 AND e.id = $3 AND ${SERVABLE}`,
      [roundId, input.accountId, entry.id, input.decision, at],
    );
    if (updated.rowCount !== 1) throw notFound();
    await tx.query(
      `UPDATE rounds r SET completed_at = $3
        WHERE r.id = $1 AND r.account_id = $2 AND r.completed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM round_entries e
                           WHERE e.round_id = r.id AND e.decision IS NULL AND ${SERVABLE})`,
      [roundId, input.accountId, at],
    );
    let match = input.decision === "like" ? standing : null;
    let opened = false;
    if (input.decision === "like" && !standing) {
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
      },
    };
  });
  const decided = written.decided;
  if (decided) {
    const now = () => at;
    await track({ ...deps, now }, input.accountId, input.decision, {
      position: input.position,
      reason: decided.reason,
      sinceSeen: decided.seenAt ? sinceSeenBand(at.getTime() - decided.seenAt.getTime()) : null,
      revised: decided.revised,
    });
    if (decided.opened) {
      await track({ ...deps, now }, input.accountId, "match", { completed: true });
      await track({ ...deps, now }, decided.candidateId, "match", { completed: false });
    }
  }
  return { match: written.match };
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
  entries: {
    position: number;
    reason: RoundReason;
    seenAt: Date | null;
    decision: RoundDecision | null;
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
    seen_at: Date | null;
    decision: RoundDecision | null;
    decided_at: Date | null;
  }>(
    `SELECT e.round_id, e.position, e.reason, e.seen_at, e.decision, e.decided_at
       FROM round_entries e JOIN rounds r ON r.id = e.round_id
      WHERE r.account_id = $1 AND r.id = ANY($2::uuid[])
      ORDER BY e.position`,
    [accountId, rows.map((row) => row.id)],
  );
  return rows.map((row) => ({
    day: row.day,
    builtAt: row.built_at,
    openedAt: row.opened_at,
    completedAt: row.completed_at,
    entries: entries.rows
      .filter((entry) => entry.round_id === row.id)
      .map((entry) => ({
        position: entry.position,
        reason: entry.reason,
        seenAt: entry.seen_at,
        decision: entry.decision,
        decidedAt: entry.decided_at,
      })),
  }));
}
