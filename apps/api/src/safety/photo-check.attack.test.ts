import { expect } from "vitest";
import { attack } from "../test/attack.ts";
import { people } from "../test/people.ts";
import { rolledBack } from "../test/rolled-back.ts";
import { prunePhotoCheckNotes } from "./photo-check.ts";

// prune-photo-check-notes (#253, #380): "a note older than twelve months goes"
// (photo-check.ts), "kept twelve months" (rules/db.md, docs/decisions.md).
// Each attack tries to make a night take a note before its twelve months.

const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
/** 04:00 in Helsinki, one October night. */
const NIGHT = new Date("2026-10-16T01:00:00.000Z");

/** One note of the check's at `at`; whether the night of `night` pruned it. */
async function pruned(at: Date, night: Date) {
  return rolledBack(async (db) => {
    const [accountId] = await people(db, null, 1, { state: "active" });
    await db.query(
      "INSERT INTO photo_check_note (account_id, kind, at) VALUES ($1, 'nudity', $2)",
      [accountId, at],
    );
    await prunePhotoCheckNotes(db, night);
    const left = await db.query("SELECT 1 FROM photo_check_note WHERE account_id = $1", [
      accountId,
    ]);
    return { pruned: left.rows.length === 0 };
  });
}

attack("prune-photo-check-notes: a note a second short of a year old is pruned", {
  attempt: () => pruned(new Date(NIGHT.getTime() - 365 * DAY + SECOND), NIGHT),
  control: () => pruned(new Date(NIGHT.getTime() - 365 * DAY - SECOND), NIGHT),
  succeeds: (seen) => expect(seen.pruned).toBe(true),
});

// 04:00 in Helsinki on 1.3.2028, after the leap day: a note of noon on
// 1.3.2027 is twelve months old only at noon; one of 28.2.2027 is past them.
const LEAP_NIGHT = new Date("2028-03-01T02:00:00.000Z");

attack(
  "prune-photo-check-notes: across a leap day, a note is pruned before it is twelve months old",
  {
    attempt: () => pruned(new Date("2027-03-01T12:00:00.000Z"), LEAP_NIGHT),
    control: () => pruned(new Date("2027-02-28T12:00:00.000Z"), LEAP_NIGHT),
    succeeds: (seen) => expect(seen.pruned).toBe(true),
  },
);
