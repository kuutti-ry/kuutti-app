import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createPool, migrate, withTemporaryDatabase } from "@kuutti/db";
import { describe, expect, it } from "vitest";
import { captureLogger } from "../test/harness.ts";
import { sendMessage } from "./messages.ts";

// Two phones sending into one conversation at the same moment (#348,
// ADR-031 §3), on a pool of real connections and committed rows: the
// conversation's row lock and the sequence taken in the statement that moves
// it on leave no gap and no duplicate, whatever the order the sends land in.
// routes.test.ts holds the same with a deterministic interleaving.

const MIGRATIONS = resolve(import.meta.dirname, "../../../../packages/db/drizzle");

describe("sends on a pool", () => {
  it("ten sends at once from both sides take the sequences one to ten, each once", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({
        connectionString: url,
        max: 6,
        applicationName: "kuutti-chat-burst",
      });
      try {
        await migrate(pool, MIGRATIONS);
        const accounts: string[] = [];
        for (const label of ["a", "b"]) {
          const identity = await pool.query<{ id: string }>(
            "INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id",
            [`kuutti chat burst ${label} ${randomUUID()}`],
          );
          const account = await pool.query<{ id: string }>(
            "INSERT INTO account (identity_id, state, birth_year, birth_month) VALUES ($1, 'active', 1990, 6) RETURNING id",
            [identity.rows[0]?.id],
          );
          accounts.push(account.rows[0]?.id as string);
        }
        const conversation = await pool.query<{ id: string }>(
          "INSERT INTO conversation DEFAULT VALUES RETURNING id",
        );
        const id = conversation.rows[0]?.id as string;
        await pool.query(
          `INSERT INTO conversation_participant (conversation_id, account_id, side)
           VALUES ($1, $2, 'a'), ($1, $3, 'b')`,
          [id, accounts[0], accounts[1]],
        );
        const { logger } = await captureLogger();
        const deps = { db: pool, logger, now: () => new Date() };
        const sent = await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            sendMessage(deps, {
              accountId: accounts[i % 2] as string,
              conversationId: id,
              clientId: randomUUID(),
              body: `Viesti ${i + 1}`,
            }),
          ),
        );
        expect(sent.every((s) => s.created)).toBe(true);
        expect(sent.map((s) => s.message.seq).sort((x, y) => x - y)).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
        ]);
        const row = await pool.query<{ next_seq: number }>(
          "SELECT next_seq FROM conversation WHERE id = $1",
          [id],
        );
        expect(row.rows[0]?.next_seq).toBe(11);
      } finally {
        await pool.end();
      }
    });
  });
});
