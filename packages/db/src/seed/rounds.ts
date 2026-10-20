import { type Queryable, transaction } from "../pool.ts";

/**
 * The round of the personas' stories (#379, ADR-034, ADR-037): Iida opens the
 * app to the day's round, the four women of the round's cast in it, Henna
 * first, who liked her yesterday, so that Iida's like back is a match.
 *
 * Two things in it no route does, written as rows, as the conversations are:
 * a like on the day before (a decision is taken on the day it is of, and the
 * day has ended), and a gate opened with a pool under `gate_k` (ADR-015 §5:
 * the count opens a gate at thirty people who can be shown; the stories have
 * four). The day's round itself is built by the round builder (#95) in the
 * API's demo commands, after the gates are counted, as the night builds it.
 */
export type PersonaRound = {
  /** Whose round the day has, by persona key: their gate is opened, once the count has let them in. */
  of: string;
  /** Who liked them the day before, by persona key: each waits first in the round as liked you. */
  likedBy: readonly string[];
};

export const PERSONA_ROUNDS: readonly PersonaRound[] = [{ of: "iida", likedBy: ["henna"] }];

/**
 * `opened`: gates opened now (none for one open before, or for somebody the
 * count has not let in); `liked`: likes written; `already`: a round of that
 * day the liker had before (the staging job runs again without a reset);
 * `missing`: a persona of the story has no account this time.
 */
export type RoundsResult = { opened: number; liked: number; already: number; missing: number };

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
 * Opens each story's gate and writes the likes of the day before, between the
 * accounts the stories gave the personas, by key. A gate is opened only for
 * somebody the count has let in (`gate_opened_check`), so the count runs
 * first. A like is the liker's round of that day with the person as its one
 * card, seen and liked at midday; a round of that day the liker has already is
 * left as it is.
 */
export async function writeRounds(
  db: Queryable,
  accounts: ReadonlyMap<string, string>,
  now: Date,
): Promise<RoundsResult> {
  const result: RoundsResult = { opened: 0, liked: 0, already: 0, missing: 0 };
  const yesterday = dayBefore(finnishDay(now));
  // Midday in Finland on the day before (noon in winter, one in summer).
  const noon = new Date(`${yesterday}T10:00:00Z`);
  for (const story of PERSONA_ROUNDS) {
    const of = accounts.get(story.of);
    if (!of) {
      result.missing += 1;
      continue;
    }
    const opened = await db.query(
      `UPDATE gate SET opened_at = $2
        WHERE account_id = $1 AND admitted_at IS NOT NULL AND opened_at IS NULL`,
      [of, now],
    );
    if (opened.rowCount) result.opened += 1;
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
