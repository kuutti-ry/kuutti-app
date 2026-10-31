import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate } from "../migrate.ts";
import { createPool, type Queryable } from "../pool.ts";
import { withTemporaryDatabase } from "../test/temporary-database.ts";
import { PERSONA_HISTORIES } from "./histories.ts";
import { openPonds, PERSONA_ROUNDS, writeRounds } from "./rounds.ts";

// The round of the stories (#379): Henna's like of Iida on the day before, and
// the ponds the demo commands open. Whether the cast pass each other's filters is the
// API's rule, tested beside it (apps/api/scripts/demo/demo-conversations.test.ts).

const MIGRATIONS = resolve(import.meta.dirname, "../..", "drizzle");

describe("the round of the stories", () => {
  it("is of a persona whose story leaves her active, liked by others whose stories do too", () => {
    const active = new Set(
      PERSONA_HISTORIES.filter((h) => h.onboarding && h.profile && h.afterwards === "nothing").map(
        (h) => h.key,
      ),
    );
    for (const story of PERSONA_ROUNDS) {
      expect(active.has(story.of), story.of).toBe(true);
      expect(story.likedBy.length).toBeGreaterThan(0);
      for (const key of story.likedBy) {
        expect(active.has(key), key).toBe(true);
        expect(key).not.toBe(story.of);
      }
    }
  });
});

describe("the demo commands' ponds", () => {
  it("opens every pond, and says how many it opened (#500, ADR-060)", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      try {
        await migrate(pool, MIGRATIONS);
        await pool.query(
          `INSERT INTO ponds (slug, name_nominative, name_inessive)
           VALUES ('paakaupunkiseutu', 'Pääkaupunkiseutu', 'Pääkaupunkiseudulla')`,
        );
        expect(await openPonds(pool)).toBe(2);
        const ponds = await pool.query("SELECT DISTINCT matching_open FROM ponds");
        expect(ponds.rows).toEqual([{ matching_open: true }]);
        expect(await openPonds(pool)).toBe(0);
      } finally {
        await pool.end();
      }
    });
  });
});

describe("writing the round of the stories", () => {
  const account = async (db: Queryable, hash: string, pondId: string) => {
    const identity = await db.query<{ id: string }>(
      "INSERT INTO identity (hetu_hmac, broker_subject) VALUES ($1, $1) RETURNING id",
      [hash],
    );
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO account (identity_id, state, birth_year, birth_month, pond_id)
       VALUES ($1, 'active', 1990, 1, $2) RETURNING id`,
      [identity.rows[0]?.id, pondId],
    );
    return rows[0]?.id as string;
  };

  it("writes the like of the day before once, and says who is missing", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      try {
        await migrate(pool, MIGRATIONS);
        const pond = await pool.query<{ id: string }>(
          `INSERT INTO ponds (slug, name_nominative, name_inessive)
           VALUES ('paakaupunkiseutu', 'Pääkaupunkiseutu', 'Pääkaupunkiseudulla') RETURNING id`,
        );
        const pondId = pond.rows[0]?.id as string;
        const iida = await account(pool, "hash-iida", pondId);
        const henna = await account(pool, "hash-henna", pondId);
        const accounts = new Map([
          ["iida", iida],
          ["henna", henna],
        ]);
        // 00:30 in Finland on 21.10.2026 (summer time ends on the 25th): the day before is the 20th.
        const now = new Date("2026-10-20T21:30:00Z");

        expect(await writeRounds(pool, accounts, now)).toEqual({
          liked: 1,
          already: 0,
          missing: 0,
        });
        const likes = await pool.query(
          `SELECT r.account_id, r.day::text AS day, e.position, e.candidate_id, e.reason, e.decision,
                  e.decided_at, e.seen_at, e.fish
             FROM rounds r JOIN round_entries e ON e.round_id = r.id`,
        );
        const midday = new Date("2026-10-20T10:00:00Z");
        expect(likes.rows).toEqual([
          {
            account_id: henna,
            day: "2026-10-20",
            position: 1,
            candidate_id: iida,
            reason: "matches_filters",
            decision: "like",
            decided_at: midday,
            seen_at: midday,
            fish: false,
          },
        ]);

        // Again, as staging's job runs without a reset: nothing new.
        expect(await writeRounds(pool, accounts, new Date("2026-10-20T22:00:00Z"))).toEqual({
          liked: 0,
          already: 1,
          missing: 0,
        });

        // Nobody to like for: no account this time.
        expect(await writeRounds(pool, new Map(), now)).toEqual({
          liked: 0,
          already: 0,
          missing: 1,
        });
        expect(await writeRounds(pool, new Map([["iida", iida]]), now)).toEqual({
          liked: 0,
          already: 0,
          missing: 1,
        });
      } finally {
        await pool.end();
      }
    });
  });

  it("takes the day before by the calendar", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      try {
        await migrate(pool, MIGRATIONS);
        const pond = await pool.query<{ id: string }>(
          `INSERT INTO ponds (slug, name_nominative, name_inessive)
           VALUES ('paakaupunkiseutu', 'Pääkaupunkiseutu', 'Pääkaupunkiseudulla') RETURNING id`,
        );
        const pondId = pond.rows[0]?.id as string;
        const iida = await account(pool, "hash-iida", pondId);
        const henna = await account(pool, "hash-henna", pondId);
        const result = await writeRounds(
          pool,
          new Map([
            ["iida", iida],
            ["henna", henna],
          ]),
          // 00:30 in Finland on 30.3.2026: 24 hours back is still the 28th.
          new Date("2026-03-29T21:30:00Z"),
        );
        expect(result).toEqual({ liked: 1, already: 0, missing: 0 });
        // The day before is the 29th by the calendar, a day of 23 hours (summer time began on it).
        const day = await pool.query("SELECT day::text AS day FROM rounds");
        expect(day.rows).toEqual([{ day: "2026-03-29" }]);
      } finally {
        await pool.end();
      }
    });
  });
});
