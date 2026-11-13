import { expect } from "vitest";
import { attack } from "../test/attack.ts";
import { people } from "../test/people.ts";
import { rolledBack } from "../test/rolled-back.ts";
import { pruneRounds } from "./rounds.ts";

// prune-rounds (#502, ADR-062 §13, #380): rounds are kept a year, counted in
// Finnish days, "the night deletes rounds older than that, their entries and
// relaxations with them". Each attack tries to make a night keep a round past
// its year, take one of exactly a year, or leave a pruned round's rows behind.

/** 04:00 in Helsinki on 16.10.2026: a year ago is 16.10.2025. */
const NIGHT = new Date("2026-10-16T01:00:00.000Z");

/** A person's round of `day` with one card and one relaxation, pruned at `at`: what is left of it. */
async function roundPruned(day: string, at: Date) {
  return rolledBack(async (db) => {
    const [owner, card] = await people(db, null, 2, { state: "active" });
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO rounds (account_id, day) VALUES ($1, $2) RETURNING id",
      [owner, day],
    );
    const id = rows[0]?.id;
    await db.query(
      `INSERT INTO round_entries (round_id, position, candidate_id, reason)
       VALUES ($1, 1, $2, 'matches_filters')`,
      [id, card],
    );
    await db.query(
      "INSERT INTO round_relaxation (round_id, field, kind) VALUES ($1, 'smoking', 'aside')",
      [id],
    );
    await pruneRounds(db, at);
    const left = await db.query<{ rounds: number; rows: number }>(
      `SELECT (SELECT count(*)::int FROM rounds WHERE id = $1) AS rounds,
              (SELECT count(*)::int FROM round_entries WHERE round_id = $1)
                + (SELECT count(*)::int FROM round_relaxation WHERE round_id = $1) AS rows`,
      [id],
    );
    return { kept: left.rows[0]?.rounds === 1, rows: left.rows[0]?.rows ?? 0 };
  });
}

attack(
  "prune-rounds: a round a year and a day old in Finland is kept at half past midnight there",
  {
    // 00:30 of 17.10 in Helsinki, still the 16th by the clock of Greenwich.
    attempt: () => roundPruned("2025-10-16", new Date("2026-10-16T21:30:00.000Z")),
    // 23:30 of 16.10 in Helsinki: the round is a year old, no more.
    control: () => roundPruned("2025-10-16", new Date("2026-10-16T20:30:00.000Z")),
    succeeds: (seen) => expect(seen.kept).toBe(true),
  },
);

attack("prune-rounds: a round of exactly a year ago is deleted", {
  attempt: () => roundPruned("2025-10-16", NIGHT),
  control: () => roundPruned("2025-10-15", NIGHT),
  succeeds: (seen) => expect(seen.kept).toBe(false),
});

attack("prune-rounds: a pruned round's entries and relaxations are left behind", {
  attempt: () => roundPruned("2025-10-15", NIGHT),
  // A round of exactly a year keeps its rows by right.
  control: () => roundPruned("2025-10-16", NIGHT),
  succeeds: (seen) => expect(seen.rows).toBeGreaterThan(0),
});
