import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate } from "../migrate.ts";
import { createPool, type Queryable } from "../pool.ts";
import { withTemporaryDatabase } from "../test/temporary-database.ts";
import { PERSONA_HISTORIES } from "./histories.ts";
import { PERSONA_ROUNDS, writeRounds } from "./rounds.ts";

// The round of the stories (#379): Iida's gate opened, and Henna's like of
// her on the day before. Whether the cast pass each other's filters is the
// API's rule, tested beside it (apps/api/scripts/demo/demo-rounds.test.ts).

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

describe("writing the round of the stories", () => {
  const account = async (db: Queryable, hash: string, pondId: string, admitted: boolean) => {
    const identity = await db.query<{ id: string }>(
      "INSERT INTO identity (hetu_hmac, broker_subject) VALUES ($1, $1) RETURNING id",
      [hash],
    );
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO account (identity_id, state, birth_year, birth_month, pond_id)
       VALUES ($1, 'active', 1990, 1, $2) RETURNING id`,
      [identity.rows[0]?.id, pondId],
    );
    const id = rows[0]?.id as string;
    await db.query(
      `INSERT INTO gate (account_id, pond_id, admitted_at, place_said) VALUES ($1, $2, $3, $4)`,
      [id, pondId, admitted ? new Date("2026-10-19T02:00:00Z") : null, admitted ? null : 1],
    );
    return id;
  };

  it("opens the gate of somebody let in, writes the like of the day before once, and says who is missing", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      try {
        await migrate(pool, MIGRATIONS);
        const pond = await pool.query<{ id: string }>(
          `INSERT INTO ponds (slug, name_nominative, name_inessive)
           VALUES ('paakaupunkiseutu', 'Pääkaupunkiseutu', 'Pääkaupunkiseudulla') RETURNING id`,
        );
        const pondId = pond.rows[0]?.id as string;
        const iida = await account(pool, "hash-iida", pondId, true);
        const henna = await account(pool, "hash-henna", pondId, true);
        const accounts = new Map([
          ["iida", iida],
          ["henna", henna],
        ]);
        // 00:30 in Finland on 21.10.2026 (summer time ends on the 25th): the day before is the 20th.
        const now = new Date("2026-10-20T21:30:00Z");

        expect(await writeRounds(pool, accounts, now)).toEqual({
          opened: 1,
          liked: 1,
          already: 0,
          missing: 0,
        });
        const gate = await pool.query<{ opened_at: Date }>(
          "SELECT opened_at FROM gate WHERE account_id = $1",
          [iida],
        );
        expect(gate.rows).toEqual([{ opened_at: now }]);
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

        // Again, as staging's job runs without a reset: nothing new, the gate as it was.
        expect(await writeRounds(pool, accounts, new Date("2026-10-20T22:00:00Z"))).toEqual({
          opened: 0,
          liked: 0,
          already: 1,
          missing: 0,
        });
        expect(
          (await pool.query("SELECT opened_at FROM gate WHERE account_id = $1", [iida])).rows,
        ).toEqual([{ opened_at: now }]);

        // Nobody to open or like for: no account this time.
        expect(await writeRounds(pool, new Map(), now)).toEqual({
          opened: 0,
          liked: 0,
          already: 0,
          missing: 1,
        });
        expect(await writeRounds(pool, new Map([["iida", iida]]), now)).toEqual({
          opened: 0,
          liked: 0,
          already: 0,
          missing: 1,
        });
      } finally {
        await pool.end();
      }
    });
  });

  it("opens no gate for somebody the count has not let in", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      try {
        await migrate(pool, MIGRATIONS);
        const pond = await pool.query<{ id: string }>(
          `INSERT INTO ponds (slug, name_nominative, name_inessive)
           VALUES ('paakaupunkiseutu', 'Pääkaupunkiseutu', 'Pääkaupunkiseudulla') RETURNING id`,
        );
        const pondId = pond.rows[0]?.id as string;
        const iida = await account(pool, "hash-iida", pondId, false);
        const henna = await account(pool, "hash-henna", pondId, true);
        const result = await writeRounds(
          pool,
          new Map([
            ["iida", iida],
            ["henna", henna],
          ]),
          new Date("2026-03-29T10:00:00Z"),
        );
        expect(result).toEqual({ opened: 0, liked: 1, already: 0, missing: 0 });
        const gate = await pool.query("SELECT opened_at FROM gate WHERE account_id = $1", [iida]);
        expect(gate.rows).toEqual([{ opened_at: null }]);
        // The day before a day of 23 hours (summer time began on 29.3.2026) is the 28th.
        const day = await pool.query("SELECT day::text AS day FROM rounds");
        expect(day.rows).toEqual([{ day: "2026-03-28" }]);
      } finally {
        await pool.end();
      }
    });
  });
});
