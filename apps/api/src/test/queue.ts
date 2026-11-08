import type { Queryable } from "@kuutti/db";
import { finnishDay } from "../lib/finnish-day.ts";
import { addPlaces } from "../matching/index.ts";
import { captureLogger } from "./harness.ts";
import { HOME, type PeopleOptions } from "./people.ts";

/**
 * What `people` is given for people who fit each other, whatever the test is
 * about: a read and a like ask both people's filters now (ADR-062 §8), so
 * everybody of one pond with these seeks everybody else of it.
 */
export const FITTING = {
  complete: true,
  consented: true,
  gender: "non_binary",
  seeks: ["non_binary"],
} as const satisfies PeopleOptions;

/** Somebody signed in, who has no profile yet, given what `FITTING` gives but the profile and the consents, in that pond. */
export async function fitIn(db: Queryable, accountId: string, pondId: string): Promise<void> {
  await db.query(
    "UPDATE account SET gender = 'non_binary', pond_id = $2, home_place = $3 WHERE id = $1",
    [accountId, pondId, HOME],
  );
}

/**
 * These people in the owner's queue on the Finnish day of `at`, in order,
 * through the queue's one writer, whatever would come by itself; the day's round.
 */
export async function queued(
  db: Queryable,
  ownerId: string,
  candidateIds: readonly string[],
  at: Date,
): Promise<string> {
  const day = finnishDay(at);
  const added = await addPlaces(
    { db, logger: (await captureLogger()).logger, now: () => at },
    {
      accountId: ownerId,
      day,
      places: candidateIds.map((candidateId) => ({
        candidateId,
        reason: "matches_filters",
        distance: "nearby",
      })),
    },
  );
  if (added === null) throw new Error("nobody's queue to add to");
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM rounds WHERE account_id = $1 AND day = $2",
    [ownerId, day],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("no round written");
  return id;
}
