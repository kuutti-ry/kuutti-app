import { type Queryable, transaction } from "@kuutti/db";
import {
  type DealBreaker,
  type RoundResponse,
  STARS_CEILING,
  type StarAnswer,
  type StarredPerson,
} from "@kuutti/schema";
import { AppError } from "../lib/errors.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import {
  addPlaces,
  budgetsOf,
  type CardOf,
  type EntryRow,
  entriesOf,
  type Matches,
  notFound,
  type Place,
  type RoundDeps,
  SERVABLE,
  STAR_OF_ENTRY,
  todayOrRefuse,
} from "./rounds.ts";

// The stars (#575, ADR-064): somebody marked for later, without a like or a pass.
// A star is the person's own and nothing else reads it: the queue leaves a starred
// person out of that person's own cards (`todayOf`, `nextCards`), and their list
// and the card it opens are here. It reaches nobody, and feeds no order, no count
// and no event. Every statement names the caller (rule 6), and no route takes
// another person's id: a star is put on a card by its place, and read, opened and
// cleared by its own id, which answers 404 to anybody but its owner. Raw
// parameterised SQL through Queryable, as `rounds.ts`, under whose locks it writes.

/** The most stars a person's list may hold (ADR-064 §5); 0 is off, and STARS_CEILING stands either way. */
const STARS_MAX_KEY = "stars_max";

/**
 * What the stars read across slices, the jobs' (`jobs/stars.ts`), handed in by
 * app.ts. `shown` says which of these people a person's list shows now, in the
 * caller's transaction when there is one; `place` is where a starred card goes in
 * today's log; `people` is the list itself.
 */
export type Stars = {
  shown: (
    db: Queryable,
    accountId: string,
    candidateIds: readonly string[],
  ) => Promise<ReadonlySet<string>>;
  place: (accountId: string, candidateId: string) => Promise<Place | null>;
  people: (accountId: string) => Promise<StarredPerson[]>;
};

const full = () => new AppError(409, "stars_full", "The person's list of stars is full");

/**
 * A star on today's card (ADR-064 §1): it spends nothing and moves no card, and
 * the same star again answers the one that stands. Like a decision it holds the
 * two accounts in id order and then the round's row, so an erasure under way
 * finishes first, one that comes later waits, and two devices cannot both pass
 * the count. A card holding a like or a pass takes none, since those take the star
 * off (§3), and one that can no longer be shown takes none either: both are the
 * 404 of a card gone. Past the most a list may hold it answers `stars_full`: the
 * count is of those the list shows now (§5), so it never says full to somebody
 * who sees fewer.
 */
export async function putStar(
  deps: RoundDeps,
  stars: Pick<Stars, "shown">,
  input: { accountId: string; day: string; position: number },
): Promise<StarAnswer> {
  const { at, today } = todayOrRefuse(deps, input.day);
  return transaction(deps.db, async (tx) => {
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
    const round = await tx.query(
      "SELECT 1 FROM rounds WHERE account_id = $1 AND day = $2 FOR UPDATE",
      [input.accountId, today],
    );
    if (round.rows.length === 0) throw notFound();
    const open = await tx.query(
      `SELECT 1 FROM round_entries e JOIN rounds r ON r.id = e.round_id
        WHERE r.account_id = $1 AND r.day = $2 AND e.position = $3
          AND (e.decision IS NULL OR e.decision = 'skip') AND ${SERVABLE}`,
      [input.accountId, today, input.position],
    );
    if (open.rows.length === 0) throw notFound();
    const held = await tx.query<{ id: string; candidate_id: string }>(
      "SELECT id, candidate_id FROM star WHERE account_id = $1",
      [input.accountId],
    );
    const standing = held.rows.find((row) => row.candidate_id === candidateId);
    if (standing) return { id: standing.id, first: false };
    if (held.rows.length >= STARS_CEILING) throw full();
    const shown = await stars.shown(
      tx,
      input.accountId,
      held.rows.map((row) => row.candidate_id),
    );
    const max = await matchingConfigNumber(tx, STARS_MAX_KEY);
    if (max > 0 && shown.size >= max) throw full();
    const written = await tx.query<{ id: string }>(
      "INSERT INTO star (account_id, candidate_id, created_at) VALUES ($1, $2, $3) RETURNING id",
      [input.accountId, candidateId, at],
    );
    const id = written.rows[0]?.id;
    if (!id) throw new Error("putStar: the star is not there");
    return { id, first: shown.size === 0 };
  });
}

/** The person takes a star off, wherever they are: the card's or the list's. 404 for one that is not theirs, or gone. */
export async function clearStar(
  db: Queryable,
  input: { accountId: string; id: string },
): Promise<void> {
  const { rowCount } = await db.query("DELETE FROM star WHERE id = $1 AND account_id = $2", [
    input.id,
    input.accountId,
  ]);
  if (rowCount !== 1) throw new AppError(404, "not_found", "No such star");
}

/** The entry of `candidateId` in the person's log of `day`, as `entriesOf` takes it. */
async function entryOfCandidate(
  db: Queryable,
  accountId: string,
  day: string,
  candidateId: string,
): Promise<EntryRow | null> {
  const { rows } = await db.query<EntryRow>(
    `SELECT e.position, e.candidate_id, e.reason, e.decision, e.fish, e.relaxed_field, e.distance,
            ${STAR_OF_ENTRY}
       FROM round_entries e JOIN rounds r ON r.id = e.round_id
      WHERE r.account_id = $1 AND r.day = $2 AND e.candidate_id = $3`,
    [accountId, day, candidateId],
  );
  return rows[0] ?? null;
}

/**
 * A star opened from the list (ADR-064 §2, §4): somebody the list shows now comes
 * into today's log, or comes as they already are there, so that the card is
 * addressed, decided and counted as any card is, with the band of when it was
 * written. The card is served by the card builder (ADR-008, ADR-041) as a read of
 * the queue serves one. An answer of the queue's shape holding that one card; 404
 * for a star that is not the caller's, or for somebody the list leaves out now.
 */
export async function openStar(
  deps: RoundDeps,
  matches: Pick<Matches, "yourTurn">,
  stars: Pick<Stars, "shown" | "place">,
  cardOf: CardOf,
  dealBreakers: readonly DealBreaker[],
  input: { accountId: string; id: string },
): Promise<RoundResponse> {
  const day = finnishDay(deps.now());
  const { accountId } = input;
  const { rows } = await deps.db.query<{ candidate_id: string }>(
    "SELECT candidate_id FROM star WHERE id = $1 AND account_id = $2",
    [input.id, accountId],
  );
  const candidateId = rows[0]?.candidate_id;
  if (!candidateId) throw notFound();
  const shown = await stars.shown(deps.db, accountId, [candidateId]);
  if (!shown.has(candidateId)) throw notFound();
  let row = await entryOfCandidate(deps.db, accountId, day, candidateId);
  if (!row) {
    const place = await stars.place(accountId, candidateId);
    if (!place) throw notFound();
    // A read beside this one may have written them first; the read back says.
    await addPlaces(deps, { accountId, day, places: [place] });
    row = await entryOfCandidate(deps.db, accountId, day, candidateId);
  }
  if (!row) throw notFound();
  await deps.db.query(
    "UPDATE rounds SET opened_at = $3 WHERE account_id = $1 AND day = $2 AND opened_at IS NULL",
    [accountId, day, deps.now()],
  );
  const entries = await entriesOf(accountId, [row], cardOf, dealBreakers);
  if (entries.length === 0) throw notFound();
  return { day, entries, ...(await budgetsOf(deps.db, matches, accountId, day)) };
}

/**
 * Erasure's part (TD-7, ADR-007 §4, ADR-064 §9), inside its transaction: the stars
 * the person put and those put on them. How many, either way.
 */
export async function eraseStarsOf(tx: Queryable, accountId: string): Promise<number> {
  const { rowCount } = await tx.query(
    "DELETE FROM star WHERE account_id = $1 OR candidate_id = $1",
    [accountId],
  );
  return rowCount ?? 0;
}

/** The person's own stars for their export, the latest first: when, never on whom. */
export async function exportStars(db: Queryable, accountId: string): Promise<Date[]> {
  const { rows } = await db.query<{ created_at: Date }>(
    "SELECT created_at FROM star WHERE account_id = $1 ORDER BY created_at DESC, id",
    [accountId],
  );
  return rows.map((row) => row.created_at);
}
