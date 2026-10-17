import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate } from "../migrate.ts";
import { createPool, type Queryable } from "../pool.ts";
import { MATCHING_CONFIG_V1 } from "../seed.ts";
import { withTemporaryDatabase } from "../test/temporary-database.ts";
import { PERSONA_CONVERSATIONS, writeConversations } from "./conversations.ts";
import { PERSONA_HISTORIES } from "./histories.ts";

// The conversations of the stories (#348, ADR-031). Whether their two people
// pass each other's filters is the API's rule, tested beside it
// (apps/api/scripts/demo/demo-conversations.test.ts).

const MIGRATIONS = resolve(import.meta.dirname, "../..", "drizzle");
const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date(Date.UTC(2026, 9, 17, 12));
const WEEK_HOURS = MATCHING_CONFIG_V1.silent_match_archive_days * 24;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR_MS);

describe("the conversations of the stories", () => {
  it("are between two personas whose stories leave them active, each conversation once", () => {
    const active = new Set(
      PERSONA_HISTORIES.filter((h) => h.onboarding && h.afterwards === "nothing").map((h) => h.key),
    );
    const pairs = PERSONA_CONVERSATIONS.map((c) => [...c.between].sort().join("+"));
    expect(new Set(pairs).size).toBe(pairs.length);
    for (const told of PERSONA_CONVERSATIONS) {
      const [a, b] = told.between;
      expect(a).not.toBe(b);
      expect(active.has(a), a).toBe(true);
      expect(active.has(b), b).toBe(true);
    }
  });

  it("run oldest first after the opening, read no further than written, within the longest message", () => {
    for (const told of PERSONA_CONVERSATIONS) {
      const where = told.between.join("+");
      let previous = told.openedHoursAgo;
      for (const message of told.messages) {
        expect(message.hoursAgo, where).toBeLessThan(previous);
        expect(message.body.trim().length, where).toBeGreaterThan(0);
        expect(message.body.length, where).toBeLessThanOrEqual(
          MATCHING_CONFIG_V1.message_max_length,
        );
        previous = message.hoursAgo;
      }
      expect(previous, where).toBeGreaterThan(0);
      for (const side of ["a", "b"] as const) {
        expect(told.readUpTo[side], where).toBeGreaterThanOrEqual(0);
        expect(told.readUpTo[side], where).toBeLessThanOrEqual(told.messages.length);
      }
    }
  });

  it("are open within the archive's week, and archived only when silent for longer, after the night's sweep", () => {
    const open = PERSONA_CONVERSATIONS.filter((c) => c.archivedHoursAgo === undefined);
    const archived = PERSONA_CONVERSATIONS.filter((c) => c.archivedHoursAgo !== undefined);
    // The chat's flow reads one of each.
    expect(open.length).toBeGreaterThan(0);
    expect(archived.length).toBeGreaterThan(0);
    for (const told of open) {
      const last = told.messages.at(-1)?.hoursAgo ?? told.openedHoursAgo;
      expect(last, told.between.join("+")).toBeLessThan(WEEK_HOURS);
      expect(told.messages.length).toBeGreaterThan(0);
    }
    for (const told of archived) {
      expect(told.messages, told.between.join("+")).toEqual([]);
      expect(told.openedHoursAgo - (told.archivedHoursAgo ?? 0)).toBeGreaterThanOrEqual(WEEK_HOURS);
    }
  });
});

describe("writing the conversations", () => {
  /** An account as a login leaves it, which is all a conversation names. */
  const account = async (db: Queryable, hash: string) => {
    const identity = await db.query<{ id: string }>(
      "INSERT INTO identity (hetu_hmac, broker_subject) VALUES ($1, $1) RETURNING id",
      [hash],
    );
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO account (identity_id, state, birth_year, birth_month)
       VALUES ($1, 'active', 1980, 1) RETURNING id`,
      [identity.rows[0]?.id],
    );
    return rows[0]?.id as string;
  };

  it("writes each between the accounts given, once, and leaves out one without an account", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      try {
        await migrate(pool, MIGRATIONS);
        const accounts = new Map<string, string>();
        for (const key of ["antti", "ville", "sanna"]) {
          accounts.set(key, await account(pool, `hash-${key}`));
        }
        expect(await writeConversations(pool, accounts, NOW)).toEqual({
          written: 2,
          already: 0,
          missing: 0,
        });

        const { rows: conversations } = await pool.query<{
          id: string;
          a: string;
          b: string;
          opened_at: Date;
          last_message_at: Date | null;
          next_seq: number;
          archived_at: Date | null;
          closed_at: Date | null;
          read_a: number;
          read_b: number;
        }>(
          `SELECT c.id, pa.account_id AS a, pb.account_id AS b, c.opened_at, c.last_message_at,
                  c.next_seq, c.archived_at, c.closed_at, pa.read_up_to AS read_a, pb.read_up_to AS read_b
           FROM conversation c
           JOIN conversation_participant pa ON pa.conversation_id = c.id AND pa.side = 'a'
           JOIN conversation_participant pb ON pb.conversation_id = c.id AND pb.side = 'b'
           ORDER BY c.opened_at DESC`,
        );
        expect(conversations).toEqual([
          {
            id: expect.any(String),
            a: accounts.get("antti"),
            b: accounts.get("ville"),
            opened_at: ago(100),
            last_message_at: ago(20),
            next_seq: 7,
            archived_at: null,
            closed_at: null,
            read_a: 5,
            read_b: 5,
          },
          {
            id: expect.any(String),
            a: accounts.get("antti"),
            b: accounts.get("sanna"),
            opened_at: ago(240),
            last_message_at: null,
            next_seq: 1,
            archived_at: ago(70),
            closed_at: null,
            read_a: 0,
            read_b: 0,
          },
        ]);
        const { rows: messages } = await pool.query<{
          seq: number;
          side: string;
          body: string;
          created_at: Date;
        }>(
          "SELECT seq, side, body, created_at FROM message WHERE conversation_id = $1 ORDER BY seq",
          [conversations[0]?.id],
        );
        const told = PERSONA_CONVERSATIONS[0];
        expect(messages).toEqual(
          told?.messages.map((m, i) => ({
            seq: i + 1,
            side: m.from,
            body: m.body,
            created_at: ago(m.hoursAgo),
          })),
        );
        const { rows: silent } = await pool.query(
          "SELECT 1 FROM message WHERE conversation_id = $1",
          [conversations[1]?.id],
        );
        expect(silent).toEqual([]);

        // Told before, between the same two accounts: left as it is.
        expect(await writeConversations(pool, accounts, NOW)).toEqual({
          written: 0,
          already: 2,
          missing: 0,
        });
        // A persona with no account this time (spared, or refused): nothing to talk in.
        accounts.delete("sanna");
        expect(await writeConversations(pool, accounts, NOW)).toEqual({
          written: 0,
          already: 1,
          missing: 1,
        });
        // Another account of the same persona is another person to Kuutti.
        accounts.set("sanna", await account(pool, "hash-sanna-again"));
        expect(await writeConversations(pool, accounts, NOW)).toEqual({
          written: 1,
          already: 1,
          missing: 0,
        });
        const count = await pool.query<{ n: string }>("SELECT count(*) AS n FROM conversation");
        expect(Number(count.rows[0]?.n)).toBe(3);
      } finally {
        await pool.end();
      }
    });
  });
});
