import type { Queryable } from "@kuutti/db";
import {
  type DistanceBand,
  pondCounterK,
  QUEUE_PAGE,
  type Relaxation,
  type RelaxationKind,
  type RelaxationOffer,
  type RoundDecision,
  saidInStep,
} from "@kuutti/schema";
import { addDays, finnishDay } from "../lib/finnish-day.ts";
import type { Logger } from "../lib/logger.ts";
import { matchingConfigNumbers } from "../lib/matching-config.ts";
import {
  addPlaces,
  bandBetween,
  comingBackOrder,
  inEachOthersPool,
  likedYouPlaces,
  mayMeet,
  type Place,
  type PoolPerson,
  pausedOf,
  type RelaxedCandidate,
  type Return,
  type RoundCandidate,
  relaxationsOf,
  relaxedBy,
  roundOrder,
} from "../matching/index.ts";
import {
  openPondOf,
  pondIdOf,
  type Subject,
  subjectOf,
  subjectsAmong,
  subjectsOfPond,
} from "./pool.ts";

/**
 * The queue's builder (#95, #502, ADR-035, ADR-062): who comes next for a
 * person. Everybody complete of a pond an admin has opened (#500, ADR-060) has a
 * queue from their first read; nothing is built at night. It lives with the jobs
 * and not in a slice for the reason `pool.ts` does: it reads across accounts,
 * profiles, photos, preferences, consents, blocks, rounds and conversations. The
 * rule of whom and in which order is the matching slice's (`roundOrder`,
 * `comingBackOrder`), the one writer too (`addPlaces`).
 *
 * A read that finds nothing left to go through adds the next people to the
 * day's log, QUEUE_PAGE at a time: the likes waiting, all of them, those who sent
 * a fish first (ADR-039), each the oldest like first (ADR-037), then ordinary
 * cards up to the page. A like waiting is of an ended day, within
 * `like_expiry_days`, not yet answered, and the two still in each other's pool.
 * A like the person passed within their clock, or of somebody they have a
 * conversation with, never comes. A shadow-banned person gets no liked-you
 * places, and the likes wait for the lift.
 *
 * An ordinary card is somebody complete who is seen by others, in each other's
 * pool both ways, not kept apart by a hidden field, not in today's log, not past
 * the inbox stop, and off the ladder's clocks (ADR-062 §6): new people first, then
 * those coming back as `seen_before`. Once neither is left, the people the day's
 * relaxations let in (ADR-042 §5). Nothing fills what is left.
 *
 * Every entry is written with the band between the two homes as they stand then
 * (ADR-061 §5), however it came into the queue.
 *
 * Nothing it reads or decides is logged: whose queue has whom in it is the round
 * record's, and the export's (ADR-034 §7).
 */
export type BuilderDeps = { db: Queryable; logger: Logger; now: () => Date };

const KEYS = [
  "pass_cooldown_days",
  "second_pass_cooldown_days",
  "liked_cooldown_days",
  "ended_cooldown_days",
  "like_expiry_days",
  "inbox_stop",
] as const;
type BuilderConfig = Record<(typeof KEYS)[number], number>;
/** The short pool reads the counter's step too (ADR-042 §4). */
const ALL_KEYS = [...KEYS, "pond_counter_k"] as const;

/** Whom the owner was shown before (ADR-042 §1, ADR-062 §6). */
type History = {
  /** Liked with no answer, within `liked_cooldown_days`: an ordinary card waits it out. */
  cooling: Set<string>;
  /** Passed within their clock, or in a conversation with the owner, or out of one within `ended_cooldown_days`: no card at all, a like of theirs neither. */
  refused: Set<string>;
  /** Everybody shown before or talked to, with when last and what they would come back from. */
  seen: Map<string, { lastShown: string; from: Return }>;
};

const RETURNS_FROM: Record<RoundDecision, Return> = {
  skip: "skipped",
  pass: "passed",
  like: "liked",
};

/**
 * Earlier days only, today's log being the one added to; and only what was
 * displayed or decided: an entry queued and never displayed showed nobody, so its
 * person starts no clock and is new again (ADR-062 §2). The latest day alone
 * rules, since a clock that ran out has nothing left to say; a card displayed and
 * left undecided reads as a skip (§3). A conversation rules over its entries: it
 * keeps the two apart while it stands and for `ended_cooldown_days` after its
 * close or its archive, and two people who have one are former conversations
 * after that, whatever their entries say.
 */
async function historyOf(
  db: Queryable,
  ownerId: string,
  day: string,
  config: BuilderConfig,
): Promise<History> {
  const history: History = { cooling: new Set(), refused: new Set(), seen: new Map() };
  const { rows: shown } = await db.query<{
    id: string;
    last_shown: string;
    decision: RoundDecision | null;
    second_pass: boolean;
  }>(
    `SELECT DISTINCT ON (e.candidate_id)
            e.candidate_id AS id, r.day::text AS last_shown, e.decision, e.second_pass
       FROM rounds r JOIN round_entries e ON e.round_id = r.id
      WHERE r.account_id = $1 AND r.day < $2::date
        AND (e.seen_at IS NOT NULL OR e.decision IS NOT NULL)
      ORDER BY e.candidate_id, r.day DESC`,
    [ownerId, day],
  );
  // A day after this is inside a clock of so many days: somebody shown exactly that long ago comes back today.
  const within = (shownOn: string, days: number) => shownOn > addDays(day, -days);
  for (const row of shown) {
    const passClock = row.second_pass
      ? config.second_pass_cooldown_days
      : config.pass_cooldown_days;
    if (row.decision === "pass" && within(row.last_shown, passClock)) history.refused.add(row.id);
    if (row.decision === "like" && within(row.last_shown, config.liked_cooldown_days)) {
      history.cooling.add(row.id);
    }
    history.seen.set(row.id, {
      lastShown: row.last_shown,
      from: RETURNS_FROM[row.decision ?? "skip"],
    });
  }
  const { rows: talked } = await db.query<{
    id: string;
    standing: boolean;
    ended_on: string | null;
  }>(
    `SELECT other.account_id AS id, c.closed_at IS NULL AND c.archived_at IS NULL AS standing,
            ((coalesce(c.closed_at, c.archived_at)) AT TIME ZONE 'Europe/Helsinki')::date::text AS ended_on
       FROM conversation_participant mine
       JOIN conversation_participant other
         ON other.conversation_id = mine.conversation_id AND other.account_id <> mine.account_id
       JOIN conversation c ON c.id = mine.conversation_id
      WHERE mine.account_id = $1`,
    [ownerId],
  );
  for (const row of talked) {
    if (row.standing || within(row.ended_on ?? day, config.ended_cooldown_days)) {
      history.refused.add(row.id);
    }
    history.seen.set(row.id, {
      lastShown: history.seen.get(row.id)?.lastShown ?? row.ended_on ?? day,
      from: "ended",
    });
  }
  return history;
}

/**
 * The people whose like waits on the owner, those who sent a fish first
 * (#378), each group the oldest like first (#97): a like of an ended day, so a
 * decision the liker may still change is never shown, within `like_expiry_days`,
 * and not answered, by a like or a pass of the owner's on the liker on the like's
 * day or after it; a skip answers nothing (ADR-062 §3). A like expired is
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
             AND answer.decision IN ('like', 'pass') AND mine.day >= r.day)
      GROUP BY r.account_id
      ORDER BY bool_or(e.fish) DESC, min(e.decided_at), r.account_id`,
    [ownerId, day, config.like_expiry_days],
  );
  return rows.map((row) => ({ ...row, waived: waivedAs(row.waived) }));
}

const waivedAs = (fields: readonly Relaxation["field"][]): Relaxation[] =>
  fields.map((field) => ({ field, kind: "aside" as const }));

type Inbox = { places: RoundCandidate[]; fish: Set<string>; waits: Set<string> };

/**
 * What the owner's inbox can show now (ADR-062 §2, §4): `places` in order, `fish`
 * who of them sent one, and `waits` everybody whose like waits, shown or not, who
 * is no ordinary card meanwhile (ADR-037).
 */
async function inboxOf(
  db: Queryable,
  owner: Subject,
  day: string,
  config: BuilderConfig,
  history: History,
  byId: ReadonlyMap<string, Subject>,
): Promise<Inbox> {
  const waiting = (await waitingOn(db, owner.id, day, config)).filter(
    (like) => !history.refused.has(like.id),
  );
  return {
    places: likedYouPlaces(
      owner,
      waiting.flatMap((like) => {
        const liker = byId.get(like.id);
        return liker ? [{ ...liker, person: relaxedBy(liker.person, like.waived) }] : [];
      }),
    ),
    fish: new Set(waiting.filter((like) => like.fish).map((like) => like.id)),
    waits: new Set(waiting.map((like) => like.id)),
  };
}

/** What one walk of the pool knows of the person's day. */
type Today = {
  day: string;
  owner: Subject;
  /** The person with today's relaxations (ADR-042 §3). */
  effective: PoolPerson;
  /** Everybody seen by others but the person. */
  shown: readonly Subject[];
  /** Everybody seen by others, the person included: whose likes an inbox can show. */
  byId: ReadonlyMap<string, Subject>;
  /** Who may still come as an ordinary card today. */
  open: readonly Subject[];
  history: History;
  inbox: Inbox;
  inLog: ReadonlySet<string>;
  relaxed: readonly Relaxation[];
  config: Record<(typeof ALL_KEYS)[number], number>;
};

/** Everybody in the person's log of `day`, decided or not. */
async function inLogOf(db: Queryable, accountId: string, day: string): Promise<Set<string>> {
  const { rows } = await db.query<{ candidate_id: string }>(
    `SELECT e.candidate_id FROM round_entries e JOIN rounds r ON r.id = e.round_id
      WHERE r.account_id = $1 AND r.day = $2`,
    [accountId, day],
  );
  return new Set(rows.map((row) => row.candidate_id));
}

/** The person's day, or null when their matching is not open or their profile not complete. */
async function todayOf(deps: BuilderDeps, accountId: string): Promise<Today | null> {
  const at = deps.now();
  const day = finnishDay(at);
  const pondId = await openPondOf(deps.db, accountId);
  if (!pondId) return null;
  // The person alone first: one whose profile does not count as complete
  // costs no read of the pool on every visit.
  if (!(await subjectOf(deps.db, pondId, accountId, at))) return null;
  // shortcut: every walk reads the whole pool, about 360 ms at 3,400 complete
  // people on the laptop (docs/runbooks/capacity.md), so a few walks a second is
  // what a core holds; the pool read a minute old and shared would lift it, and
  // is safe, since every card is asked again fresh before it is served (`fitsNow`).
  const subjects = await subjectsOfPond(deps.db, pondId, at);
  const owner = subjects.find((subject) => subject.id === accountId);
  if (!owner) return null;
  const config = await matchingConfigNumbers(deps.db, ALL_KEYS);
  const history = await historyOf(deps.db, accountId, day, config);
  const inLog = await inLogOf(deps.db, accountId, day);
  // A star is the person's own way back to somebody, so they are no ordinary card
  // meanwhile (ADR-064 §4); nothing else of this walk, or anybody else's, reads it.
  const starred = await deps.db.query<{ candidate_id: string }>(
    "SELECT candidate_id FROM star WHERE account_id = $1",
    [accountId],
  );
  const stars = new Set(starred.rows.map((row) => row.candidate_id));
  const shown = subjects.filter((subject) => subject.visible && subject.id !== accountId);
  const byId = new Map(
    subjects.filter((subject) => subject.visible).map((subject) => [subject.id, subject]),
  );
  const inbox = await inboxOf(deps.db, owner, day, config, history, byId);
  const open = shown.filter(
    (subject) =>
      !history.refused.has(subject.id) &&
      !history.cooling.has(subject.id) &&
      !inbox.waits.has(subject.id) &&
      !inLog.has(subject.id) &&
      !stars.has(subject.id),
  );
  const relaxed = (await relaxationsOf(deps.db, accountId, day))?.relaxed ?? [];
  const effective = relaxedBy(owner.person, relaxed);
  return { day, owner, effective, shown, byId, open, history, inbox, inLog, relaxed, config };
}

/**
 * Of these people, those whose pile keeps them out of everybody's ordinary queue
 * (ADR-062 §4): `inbox_stop` likes their own inbox can show now. Counted raw
 * first, in one statement, and asked exactly only of those at the stop, three
 * statements each; the raw count is never below the exact one, so nobody is missed.
 */
// shortcut: this and `waitingOn` go through a candidate's whole kept year of
// entries for two weeks of likes, some thousands of rows each by a year's end, and
// each walk asks again of whoever is at the stop; a partial index on
// `round_entries (candidate_id) WHERE decision = 'like'` and a memo per walk lift
// it, when capacity.md's run asks.

async function heldBack(
  db: Queryable,
  t: Pick<Today, "day" | "byId" | "config">,
  ids: readonly string[],
): Promise<Set<string>> {
  const held = new Set<string>();
  for (const id of await atTheStop(db, t, ids)) {
    const person = t.byId.get(id);
    if (!person) continue;
    const history = await historyOf(db, id, t.day, t.config);
    const { places } = await inboxOf(db, person, t.day, t.config, history, t.byId);
    if (places.length >= t.config.inbox_stop) held.add(id);
  }
  return held;
}

/** The raw count's half of `heldBack`. */
async function atTheStop(
  db: Queryable,
  t: { day: string; config: BuilderConfig },
  ids: readonly string[],
): Promise<string[]> {
  const stop = t.config.inbox_stop;
  if (stop <= 0) return [];
  const { rows } = await db.query<{ id: string }>(
    `SELECT e.candidate_id AS id
       FROM round_entries e JOIN rounds r ON r.id = e.round_id
      WHERE e.candidate_id = ANY($1::uuid[]) AND e.decision = 'like'
        AND r.day < $2::date AND r.day > $2::date - $3::int
        AND NOT EXISTS (
          SELECT 1 FROM rounds mine JOIN round_entries answer ON answer.round_id = mine.id
           WHERE mine.account_id = e.candidate_id AND answer.candidate_id = r.account_id
             AND answer.decision IN ('like', 'pass') AND mine.day >= r.day)
      GROUP BY e.candidate_id
     HAVING count(DISTINCT r.account_id) >= $4`,
    [ids, t.day, t.config.like_expiry_days, stop],
  );
  return rows.map((row) => row.id);
}

/**
 * Of these people, whom a person's Starred list leaves out by the queue's rules
 * (ADR-064 §6). Nothing may tell that somebody's pile is at the inbox stop (ADR-062
 * §4), so the stop is asked with care. Whoever the person's own queue shows today
 * anyway, in today's log or with a like waiting on them, is not asked it: their
 * leaving the list while the queue still shows them would say why, and a like on
 * them is no new way past the stop. The rest are asked the raw count alone, one
 * statement whoever is on the list: the exact count reads the whole pool for
 * whoever is at the stop, so the answer's time would say it. A shadow-banned
 * person's star on somebody whose like waits waits for the lift as the like does,
 * since that person is no ordinary card meanwhile (ADR-037 §7).
 */
export async function heldFromStars(
  deps: Pick<BuilderDeps, "now">,
  db: Queryable,
  accountId: string,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  const day = finnishDay(deps.now());
  const config = await matchingConfigNumbers(db, KEYS);
  const waits = new Set((await waitingOn(db, accountId, day, config)).map((like) => like.id));
  const queued = await inLogOf(db, accountId, day);
  const stopped = await atTheStop(
    db,
    { day, config },
    ids.filter((id) => !waits.has(id) && !queued.has(id)),
  );
  const me = await db.query("SELECT 1 FROM account WHERE id = $1 AND state = 'shadow_banned'", [
    accountId,
  ]);
  return new Set([...stopped, ...(me.rows.length > 0 ? ids.filter((id) => waits.has(id)) : [])]);
}

/**
 * Whether this person's like or fish waits on the owner, by the rule of the owner's
 * inbox (ADR-062 §2): the card's label, for a card that comes by another way (the
 * Starred list, ADR-064 §4). Null with none.
 */
export async function likeWaiting(
  db: Queryable,
  owner: Subject,
  candidate: Subject,
  day: string,
): Promise<"liked_you" | "fish" | null> {
  const config = await matchingConfigNumbers(db, KEYS);
  const history = await historyOf(db, owner.id, day, config);
  const byId = new Map([[candidate.id, candidate]]);
  const inbox = await inboxOf(db, owner, day, config, history, byId);
  if (!inbox.places.some((place) => place.id === candidate.id)) return null;
  return inbox.fish.has(candidate.id) ? "fish" : "liked_you";
}

/**
 * The ordinary cards in their order (ADR-042 §1, ADR-062 §2): everybody new
 * first, the nearest band first and then by their soft matches (ADR-061 §6);
 * then the people coming back, in the order they do, which no band moves.
 */
function orderedPlaces(
  owner: Subject,
  candidates: readonly Subject[],
  history: History,
  day: string,
): Place[] {
  const size = candidates.length;
  const fresh = roundOrder(
    owner,
    candidates.filter((subject) => !history.seen.has(subject.id)),
    { day, size },
  );
  const back = comingBackOrder(
    owner,
    candidates.flatMap((subject) => {
      const before = history.seen.get(subject.id);
      return before ? [{ ...subject, ...before }] : [];
    }),
    { day, size },
  );
  const distance = (candidate: RoundCandidate): DistanceBand =>
    bandBetween(owner.person.home, candidate.person.home);
  return [
    ...fresh.map((candidate) => ({
      candidateId: candidate.id,
      reason: "matches_filters" as const,
      distance: distance(candidate),
    })),
    ...back.map((candidate) => ({
      candidateId: candidate.id,
      reason: "seen_before" as const,
      distance: distance(candidate),
    })),
  ];
}

/** Who a relaxation lets in: in each other's pool with it, and not without it (ADR-042 §3). */
const letsIn = (wider: PoolPerson, narrower: PoolPerson) => (subject: Subject) =>
  inEachOthersPool(wider, subject.person) && !inEachOthersPool(narrower, subject.person);

/** The day's relaxations somebody needs: those without which the person's filters still keep them out. */
export function needsOf(owner: PoolPerson, relaxed: readonly Relaxation[], candidate: PoolPerson) {
  return relaxed
    .filter(
      (r) =>
        !inEachOthersPool(
          relaxedBy(
            owner,
            relaxed.filter((other) => other.field !== r.field),
          ),
          candidate,
        ),
    )
    .map((r) => r.field);
}

/** Whom today's relaxations still let in (ADR-042 §5, ADR-062 §10), in the order they come, each with the relaxations they need. */
function relaxedPlaces(t: Today): Place[] {
  if (t.relaxed.length === 0) return [];
  const admitted = t.open.filter(letsIn(t.effective, t.owner.person));
  const person = new Map(admitted.map((subject) => [subject.id, subject.person]));
  return orderedPlaces({ ...t.owner, person: t.effective }, admitted, t.history, t.day).flatMap(
    (place) => {
      const candidate = person.get(place.candidateId);
      return candidate
        ? [
            {
              ...place,
              reason: "relaxed" as const,
              relaxedWith: needsOf(t.owner.person, t.relaxed, candidate),
            },
          ]
        : [];
    },
  );
}

/** Up to `size` of these, in order, leaving out whoever the inbox stop holds back. */
async function notHeld(
  db: Queryable,
  t: Today,
  places: readonly Place[],
  size: number,
): Promise<Place[]> {
  const taken: Place[] = [];
  for (let from = 0; from < places.length && taken.length < size; from += QUEUE_PAGE) {
    const chunk = places.slice(from, from + QUEUE_PAGE);
    const held = await heldBack(
      db,
      t,
      chunk.map((place) => place.candidateId),
    );
    taken.push(...chunk.filter((place) => !held.has(place.candidateId)));
  }
  return taken.slice(0, size);
}

/**
 * The next places of the person's queue (ADR-062 §1, §2). A shadow-banned person
 * gets no liked-you or fish places (the maintainer, 21/10/2026, ADR-037 §7): a
 * like back would make no match (ADR-038 §1), and so tell them of the ban
 * (ADR-024 §7). Those likes wait for the lift, their clock running, and their
 * people are no ordinary cards meanwhile.
 */
async function nextPlaces(db: Queryable, t: Today): Promise<Place[]> {
  const likes = t.owner.visible
    ? t.inbox.places
        .filter((candidate) => !t.inLog.has(candidate.id))
        .map((candidate) => ({
          candidateId: candidate.id,
          reason: t.inbox.fish.has(candidate.id) ? ("fish" as const) : ("liked_you" as const),
          distance: bandBetween(t.owner.person.home, candidate.person.home),
        }))
    : [];
  const room = QUEUE_PAGE - likes.length;
  if (room <= 0) return likes;
  const ordinary = await notHeld(db, t, orderedPlaces(t.owner, t.open, t.history, t.day), room);
  if (ordinary.length > 0 || likes.length > 0) return [...likes, ...ordinary];
  return notHeld(db, t, relaxedPlaces(t), QUEUE_PAGE);
}

/**
 * The next people of the person's queue, added to the day's log, which this
 * opens if it is the day's first read (ADR-062 §1). Whether anybody was added:
 * false for a person with no matching, and at the queue's end. A read beside this
 * one that added first leaves this one nothing to add (`addPlaces`).
 */
export async function fillQueue(deps: BuilderDeps, accountId: string): Promise<boolean> {
  const t = await todayOf(deps, accountId);
  if (!t) return false;
  const places = await nextPlaces(deps.db, t);
  return ((await addPlaces(deps, { accountId, day: t.day, places })) ?? 0) > 0;
}

/**
 * Which of these people fit the person now, both ways (ADR-062 §8), with today's
 * relaxations on the person's side (ADR-042 §3) and, on the other's, the
 * deal-breakers their own like waived for the person (§7). Read fresh, in the
 * caller's transaction when there is one, for one read's cards or one like. A
 * person who is not complete now fits nobody, and the pool's own question decides
 * the rest: `subjectsAmong` leaves out whoever is not complete.
 */
export async function fitsNow(
  deps: Pick<BuilderDeps, "now">,
  db: Queryable,
  accountId: string,
  candidateIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const fitting = await fittingNow(deps, db, accountId, candidateIds);
  return new Set(fitting.map((subject) => subject.id));
}

/** The people `fitsNow` names, as subjects: the Starred list also asks whether they are seen by others (ADR-064 §6). */
export async function fittingNow(
  deps: Pick<BuilderDeps, "now">,
  db: Queryable,
  accountId: string,
  candidateIds: readonly string[],
): Promise<Subject[]> {
  const at = deps.now();
  const day = finnishDay(at);
  const pondId = await pondIdOf(db, accountId);
  if (!pondId) return [];
  const subjects = await subjectsAmong(db, pondId, [accountId, ...candidateIds], at);
  const owner = subjects.find((subject) => subject.id === accountId);
  if (!owner) return [];
  const { like_expiry_days: expiry } = await matchingConfigNumbers(db, ["like_expiry_days"]);
  const { rows: likes } = await db.query<{ id: string; waived: Relaxation["field"][] }>(
    `SELECT r.account_id AS id,
            coalesce(array_agg(DISTINCT w.field) FILTER (WHERE w.field IS NOT NULL), '{}') AS waived
       FROM round_entries e JOIN rounds r ON r.id = e.round_id
       LEFT JOIN LATERAL unnest(e.relaxed_with) AS w(field) ON true
      WHERE e.candidate_id = $1 AND r.account_id = ANY($2::uuid[]) AND e.decision = 'like'
        AND r.day > $3::date - $4::int
      GROUP BY r.account_id`,
    [accountId, candidateIds, day, expiry],
  );
  const waived = new Map(likes.map((like) => [like.id, waivedAs(like.waived)]));
  const relaxed = (await relaxationsOf(db, accountId, day))?.relaxed ?? [];
  const person = { ...owner, person: relaxedBy(owner.person, relaxed) };
  return subjects.filter((subject) =>
    mayMeet(person, {
      ...subject,
      person: relaxedBy(subject.person, waived.get(subject.id) ?? []),
    }),
  );
}

/**
 * What the queue may relax today (ADR-042 §4, ADR-062 §10), counted now: once no
 * new person is left, each of the person's own deal-breakers, not paused and not
 * relaxed today, each way it can be, with how much it widens the pool in the
 * counter's steps, and listed only when it would add somebody today. Whoever the
 * inbox stop holds back is in no queue, so neither of those counts them. Null with
 * no round today.
 */
export async function relaxationOffers(
  deps: BuilderDeps,
  accountId: string,
): Promise<{ short: boolean; offers: RelaxationOffer[] } | null> {
  const t = await todayOf(deps, accountId);
  if (!t || !(await relaxationsOf(deps.db, accountId, t.day))) return null;
  const owner = { ...t.owner, person: t.effective };
  const fresh = t.open.filter((subject) => !t.history.seen.has(subject.id));
  const newcomer = await notHeld(deps.db, t, orderedPlaces(owner, fresh, t.history, t.day), 1);
  const short = newcomer.length === 0;
  if (!short) return { short, offers: [] };
  const relaxed = new Set<string>(t.relaxed.map((r) => r.field));
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
      const places = orderedPlaces(
        { ...t.owner, person: wider },
        t.open.filter(admits),
        t.history,
        t.day,
      );
      if ((await notHeld(deps.db, t, places, 1)).length === 0) continue;
      offers.push({
        field: dealBreaker.field,
        kind,
        // The counter's step, floored at its minimum, as every figure about people is said (ADR-042 §4).
        more: saidInStep(t.shown.filter(admits).length, pondCounterK(t.config.pond_counter_k)),
      });
    }
  }
  return { short, offers };
}

/**
 * Whom a relaxation lets in first, a page of them in the order they would come
 * (ADR-042 §5, ADR-062 §10): new people first, the nearest band first and then by
 * their soft matches, then the order of coming back, past whoever the inbox stop
 * holds back; with the day's relaxations they were counted under, on top of which
 * this one loosens the person's filters. The next reads go on to the rest. Null
 * for a relaxation the offers would not list: no round today, a field that is no
 * deal-breaker of the person's, a paused one, one relaxed today, or `unanswered`
 * where those people are let through already.
 */
export async function relaxedCandidates(
  deps: BuilderDeps,
  accountId: string,
  relaxation: Relaxation,
): Promise<{ basis: Relaxation[]; candidates: RelaxedCandidate[] } | null> {
  const t = await todayOf(deps, accountId);
  if (!t || !(await relaxationsOf(deps.db, accountId, t.day))) return null;
  // The stored deal-breaker: one relaxed today meanwhile is the writer's to refuse, under the round's lock.
  const dealBreaker = t.owner.person.dealBreakers.find((d) => d.field === relaxation.field);
  if (!dealBreaker || pausedOf(dealBreaker.field, t.owner.person.fields)) return null;
  if (relaxation.kind === "unanswered" && dealBreaker.includeUnknown) return null;
  const wider = relaxedBy(t.effective, [relaxation]);
  const admitted = t.open.filter(letsIn(wider, t.effective));
  const byId = new Map(admitted.map((subject) => [subject.id, subject.person]));
  const all = [...t.relaxed, relaxation];
  const places = orderedPlaces({ ...t.owner, person: wider }, admitted, t.history, t.day);
  const candidates = (await notHeld(deps.db, t, places, QUEUE_PAGE)).flatMap((place) => {
    const person = byId.get(place.candidateId);
    return person
      ? [
          {
            candidateId: place.candidateId,
            // The day's other relaxations this one needs, the tapped one aside (the writer puts it first).
            needs: needsOf(t.owner.person, all, person).filter((f) => f !== relaxation.field),
            distance: place.distance,
          },
        ]
      : [];
  });
  return { basis: [...t.relaxed], candidates };
}
