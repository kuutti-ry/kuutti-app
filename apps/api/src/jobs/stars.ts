import type { Queryable } from "@kuutti/db";
import type { StarredPerson } from "@kuutti/schema";
import { finnishDay } from "../lib/finnish-day.ts";
import { bandBetween, type Place } from "../matching/index.ts";
import { ageInYears } from "../profile/index.ts";
import { openPondOf, subjectsAmong } from "./pool.ts";
import { type BuilderDeps, fittingNow, likeWaiting, stoppedAmong } from "./round-builder.ts";

/**
 * What the stars read across slices (#575, ADR-064), with the jobs for the reason
 * the queue's builder is: accounts, profiles, photos, cards shown, preferences and
 * blocks. Nothing here writes, and nothing it reads or decides is logged.
 */

/**
 * Which of these people a person's Starred list shows now (ADR-064 §6): matching
 * open for the person, the two in each other's pool both ways as the queue asks it
 * (ADR-062 §8), the other seen by others, and not past the inbox stop. Asked on
 * every read, and never remembered, so somebody left out comes back by themselves
 * when they pass again. In the caller's transaction when there is one.
 */
export async function starsShown(
  deps: Pick<BuilderDeps, "now">,
  db: Queryable,
  accountId: string,
  candidateIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (candidateIds.length === 0) return new Set();
  const pondId = await openPondOf(db, accountId);
  if (!pondId) return new Set();
  const fitting = (await fittingNow(deps, db, accountId, candidateIds))
    .filter((subject) => subject.visible)
    .map((subject) => subject.id);
  const stopped = await stoppedAmong(deps, db, pondId, fitting);
  return new Set(fitting.filter((id) => !stopped.has(id)));
}

/**
 * Where a starred card goes in today's log when opened (ADR-064 §4): as the queue
 * would have this person now, a like waiting first, and otherwise seen before, the
 * person having been shown them; never a label of its own, which would carry a star
 * into the research events. A shadow-banned person's card never says a like waits
 * (ADR-037 §7). With the band as it stands now (ADR-061 §5). Null while either is
 * not complete, or matching is not open for the person.
 */
export async function starPlace(
  deps: BuilderDeps,
  accountId: string,
  candidateId: string,
): Promise<Place | null> {
  const at = deps.now();
  const pondId = await openPondOf(deps.db, accountId);
  if (!pondId) return null;
  const subjects = await subjectsAmong(deps.db, pondId, [accountId, candidateId], at);
  const owner = subjects.find((subject) => subject.id === accountId);
  const candidate = subjects.find((subject) => subject.id === candidateId);
  if (!owner || !candidate) return null;
  const waits = owner.visible ? await likeWaiting(deps.db, owner, candidate, finnishDay(at)) : null;
  return {
    candidateId,
    reason: waits ?? "seen_before",
    distance: bandBetween(owner.person.home, candidate.person.home),
  };
}

/**
 * The Starred list (ADR-064 §6), one statement that names the person (rule 6): the
 * latest star first and in no other order, each with a name, an age, and the main
 * one of the approved photos the person was shown, since a photo never shown has no
 * `card_shown` row and goes nowhere (ADR-008 §3), its blurhash included.
 */
export async function starredPeople(
  deps: Pick<BuilderDeps, "db" | "now">,
  accountId: string,
): Promise<StarredPerson[]> {
  const { rows } = await deps.db.query<{
    id: string;
    candidate_id: string;
    display_name: string;
    birth_year: number | null;
    birth_month: number | null;
    photo_id: string | null;
    blurhash: string | null;
  }>(
    `SELECT s.id, s.candidate_id, pr.display_name, a.birth_year, a.birth_month,
            ph.id AS photo_id, ph.blurhash
       FROM star s
       JOIN account a ON a.id = s.candidate_id
       JOIN profile pr ON pr.account_id = s.candidate_id
       LEFT JOIN LATERAL (
         SELECT p.id, p.blurhash FROM photo p
          WHERE p.account_id = s.candidate_id AND p.purpose = 'profile' AND p.state = 'approved'
            AND EXISTS (SELECT 1 FROM card_shown c WHERE c.account_id = s.account_id AND c.photo_id = p.id)
          ORDER BY p.position, p.id LIMIT 1) ph ON true
      WHERE s.account_id = $1
      ORDER BY s.created_at DESC, s.id`,
    [accountId],
  );
  const shown = await starsShown(
    deps,
    deps.db,
    accountId,
    rows.map((row) => row.candidate_id),
  );
  const at = deps.now();
  return rows.flatMap((row) =>
    shown.has(row.candidate_id) && row.birth_year !== null && row.birth_month !== null
      ? [
          {
            id: row.id,
            name: row.display_name,
            age: ageInYears(row.birth_year, row.birth_month, at),
            photo:
              row.photo_id !== null && row.blurhash !== null
                ? { id: row.photo_id, blurhash: row.blurhash }
                : null,
          },
        ]
      : [],
  );
}
