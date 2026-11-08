import { type Queryable, transaction } from "../pool.ts";

/**
 * The round of the personas' stories (#379, ADR-034, ADR-037, ADR-062): Iida
 * opens the app to the day's queue, the four women of the round's cast in it,
 * Henna first, who liked her yesterday, so that Iida's like back is a match.
 *
 * One thing in it no route does, written as rows, as the conversations are:
 * a like on the day before (a decision is taken on the day it is of, and the
 * day has ended). The day itself is opened by the queue's builder (#502) in the
 * API's demo commands, in a pond they have opened (`openPonds`), as the day's
 * first read would.
 */
export type PersonaRound = {
  /** Whose round the day has, by persona key. */
  of: string;
  /** Who liked them the day before, by persona key: each waits first in the round as liked you. */
  likedBy: readonly string[];
};

export const PERSONA_ROUNDS: readonly PersonaRound[] = [{ of: "iida", likedBy: ["henna"] }];

/** What waits on somebody the day after it was given, by key (#560): nothing of it opens their day. */
export type WaitingLikes = {
  of: string;
  fishFrom: readonly string[];
  likedBy: readonly string[];
};

/**
 * `liked`: likes written; `already`: a round of that day the liker had before
 * (the staging job runs again without a reset); `missing`: a persona of the
 * story has no account this time.
 */
export type RoundsResult = { liked: number; already: number; missing: number };

/** The Finnish calendar day of an instant, as YYYY-MM-DD (the API's `finnishDay`). */
const finnishDay = (at: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Helsinki",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);

/** The day before a Finnish day, by the calendar: a day of 23 or 25 hours is still one day. */
function dayBefore(day: string): string {
  const at = new Date(`${day}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString().slice(0, 10);
}

/**
 * Opens every pond, for the demo commands: their people need rounds (ADR-014,
 * ADR-060 Open 1). Never an admin's switch: the commands refuse production. How
 * many ponds it opened.
 */
export async function openPonds(db: Queryable): Promise<number> {
  const { rowCount } = await db.query(
    "UPDATE ponds SET matching_open = true WHERE NOT matching_open",
  );
  return rowCount ?? 0;
}

/**
 * Writes the likes of the day before, between the accounts the stories gave the
 * personas, by key. A like is the liker's round of that day with the person as
 * its one card, seen and liked at midday; a round of that day the liker has
 * already is left as it is.
 */
export async function writeRounds(
  db: Queryable,
  accounts: ReadonlyMap<string, string>,
  now: Date,
): Promise<RoundsResult> {
  const result: RoundsResult = { liked: 0, already: 0, missing: 0 };
  const yesterday = dayBefore(finnishDay(now));
  // Midday in Finland on the day before (noon in winter, one in summer).
  const noon = new Date(`${yesterday}T10:00:00Z`);
  for (const story of PERSONA_ROUNDS) {
    const of = accounts.get(story.of);
    if (!of) {
      result.missing += 1;
      continue;
    }
    for (const key of story.likedBy) {
      const liker = accounts.get(key);
      if (!liker) {
        result.missing += 1;
        continue;
      }
      const written = await transaction(db, async (tx) => {
        const round = await tx.query<{ id: string }>(
          `INSERT INTO rounds (account_id, day, built_at, opened_at, completed_at)
           VALUES ($1, $2, $3, $3, $3)
           ON CONFLICT (account_id, day) DO NOTHING RETURNING id`,
          [liker, yesterday, noon],
        );
        const id = round.rows[0]?.id;
        if (!id) return false;
        await tx.query(
          `INSERT INTO round_entries (round_id, position, candidate_id, reason, seen_at, decision, decided_at)
           VALUES ($1, 1, $2, 'matches_filters', $3, 'like', $3)`,
          [id, of, noon],
        );
        return true;
      });
      if (written) result.liked += 1;
      else result.already += 1;
    }
  }
  return result;
}

/**
 * Writes likes and fish of the day before, as `writeRounds` does, for people who
 * like more than one person: the liker's one round of that day holds them all.
 * A like already there stays, so a second run on the same day writes nothing.
 */
export async function writeWaitingLikes(
  db: Queryable,
  stories: readonly WaitingLikes[],
  accounts: ReadonlyMap<string, string>,
  now: Date,
): Promise<RoundsResult> {
  const result: RoundsResult = { liked: 0, already: 0, missing: 0 };
  const yesterday = dayBefore(finnishDay(now));
  // Midday in Finland on the day before (noon in winter, one in summer).
  const noon = new Date(`${yesterday}T10:00:00Z`);
  for (const story of stories) {
    const of = accounts.get(story.of);
    const likes = [
      ...story.fishFrom.map((key) => ({ key, fish: true })),
      ...story.likedBy.map((key) => ({ key, fish: false })),
    ];
    for (const { key, fish } of likes) {
      const liker = accounts.get(key);
      if (!of || !liker) {
        result.missing += 1;
        continue;
      }
      const written = await transaction(db, async (tx) => {
        const round = await tx.query<{ id: string }>(
          `INSERT INTO rounds (account_id, day, built_at, opened_at, completed_at)
           VALUES ($1, $2, $3, $3, $3)
           ON CONFLICT (account_id, day) DO UPDATE SET account_id = EXCLUDED.account_id
           RETURNING id`,
          [liker, yesterday, noon],
        );
        const entry = await tx.query(
          `INSERT INTO round_entries
             (round_id, position, candidate_id, reason, seen_at, decision, decided_at, fish)
           SELECT $1::uuid, coalesce(max(position), 0) + 1, $2::uuid, 'matches_filters', $3::timestamptz,
                  'like', $3::timestamptz, $4::boolean
             FROM round_entries WHERE round_id = $1::uuid
           ON CONFLICT (candidate_id, round_id) DO NOTHING`,
          [round.rows[0]?.id, of, noon, fish],
        );
        return entry.rowCount === 1;
      });
      if (written) result.liked += 1;
      else result.already += 1;
    }
  }
  return result;
}
