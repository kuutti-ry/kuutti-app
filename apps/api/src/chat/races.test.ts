import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createPool, migrate, type Queryable, withTemporaryDatabase } from "@kuutti/db";
import { describe, expect, it } from "vitest";
import { eraseAccount } from "../identity/index.ts";
import { interleaved } from "../test/chat.ts";
import { captureLogger } from "../test/harness.ts";
import { archiveSilentConversations } from "./archive.ts";
import { removeContact, shareContact } from "./contacts.ts";
import { sendMessage } from "./messages.ts";

// Two phones sending into one conversation at the same moment (#348,
// ADR-031 §3), on a pool of real connections and committed rows: the
// conversation's row lock and the sequence taken in the statement that moves
// it on leave no gap and no duplicate, whatever the order the sends land in.
// routes.test.ts holds the same with a deterministic interleaving. A
// contact's removal and its owner's erasure (#103, ADR-031 §11), and a share
// and the night's archive (TD-13), each on a connection of its own, the one
// let go on only once the other waits for it (pg_blocking_pids, never a sleep).

const MIGRATIONS = resolve(import.meta.dirname, "../../../../packages/db/drizzle");

const codeOf = (error: unknown) => (error as { code?: string }).code ?? String(error);

type Watched<T> = { outcome: Promise<T | string>; settled: () => boolean };

/** The work's outcome as a value, a failure as its code, and whether it has settled yet. */
function watched<T>(work: Promise<T>): Watched<T> {
  let settled = false;
  const outcome = work.then(
    (value): T | string => {
      settled = true;
      return value;
    },
    (error: unknown) => {
      settled = true;
      return codeOf(error);
    },
  );
  return { outcome, settled: () => settled };
}

async function pidOf(connection: Queryable): Promise<number> {
  const { rows } = await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return rows[0]?.pid as number;
}

/**
 * Asks Postgres until the waiter waits for a lock the holder holds (true),
 * or the waiter's work has settled without (false).
 */
async function waitsFor(
  db: Queryable,
  waiter: number,
  holder: number,
  settled: () => boolean,
): Promise<boolean> {
  for (;;) {
    const { rows } = await db.query<{ waits: boolean }>(
      "SELECT $2::int = ANY(pg_blocking_pids($1)) AS waits",
      [waiter, holder],
    );
    if (rows[0]?.waits === true) return true;
    if (settled()) return false;
  }
}

/** Two active accounts with their identities, and a conversation between them, side a and side b. */
async function twoInAConversation(db: Queryable, label: string) {
  const accounts: string[] = [];
  for (const side of ["a", "b"]) {
    const identity = await db.query<{ id: string }>(
      "INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id",
      [`${label} ${side} ${randomUUID()}`],
    );
    const account = await db.query<{ id: string }>(
      "INSERT INTO account (identity_id, state, birth_year, birth_month) VALUES ($1, 'active', 1990, 6) RETURNING id",
      [identity.rows[0]?.id],
    );
    accounts.push(account.rows[0]?.id as string);
  }
  const conversation = await db.query<{ id: string }>(
    "INSERT INTO conversation DEFAULT VALUES RETURNING id",
  );
  const id = conversation.rows[0]?.id as string;
  await db.query(
    `INSERT INTO conversation_participant (conversation_id, account_id, side)
     VALUES ($1, $2, 'a'), ($1, $3, 'b')`,
    [id, accounts[0], accounts[1]],
  );
  return { a: accounts[0] as string, b: accounts[1] as string, id };
}

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
        const { a, b, id } = await twoInAConversation(pool, "kuutti chat burst");
        const accounts = [a, b];
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

describe("a contact's removal against its owner's erasure", () => {
  it("A removal and an erasure of the same person at once never wait for each other in a cycle", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({
        connectionString: url,
        max: 4,
        applicationName: "kuutti-contact-race",
      });
      const removing = await pool.connect();
      const erasing = await pool.connect();
      try {
        await migrate(pool, MIGRATIONS);
        const { a, id } = await twoInAConversation(pool, "kuutti contact race");
        await pool.query(
          "INSERT INTO contact (account_id, kind, value) VALUES ($1, 'phone', '+358401234567')",
          [a],
        );
        await pool.query(
          "INSERT INTO contact_share (conversation_id, side, kind) VALUES ($1, 'a', 'phone')",
          [id],
        );
        const { logger } = await captureLogger();
        const removalPid = await pidOf(removing);
        const erasurePid = await pidOf(erasing);
        await removing.query("BEGIN");
        await erasing.query("BEGIN");
        // The erasure starts once the removal holds the account and before it
        // deletes the piece, and the removal goes on once the erasure waits for
        // it. A removal that took the piece before the account would let the
        // erasure through here to end the shares and delete the pieces; with
        // the piece taken first, each would wait for the other until Postgres
        // broke the cycle with 40P01. The removal is stopped then, so the test
        // fails rather than hangs.
        let erasure: Watched<null> | undefined;
        let waited = false;
        const db = interleaved(removing, /^DELETE FROM contact WHERE/, async () => {
          const started = watched(
            eraseAccount({ db: erasing, logger, now: () => new Date() }, a).then(() => null),
          );
          erasure = started;
          waited = await waitsFor(pool, erasurePid, removalPid, started.settled);
          if (!waited) throw new Error("the erasure went through without waiting for the removal");
        });
        const removed = await removeContact(
          { db, logger, now: () => new Date() },
          { accountId: a, kind: "phone" },
        ).then(() => null, codeOf);
        await removing.query(removed === null ? "COMMIT" : "ROLLBACK");
        const erased = await erasure?.outcome;
        await erasing.query(erased === null ? "COMMIT" : "ROLLBACK");
        expect(db.ran()).toBe(true);
        // The erasure waited for the removal, and the removal went on without waiting for it.
        expect(waited).toBe(true);
        expect({ removed, erased }).toEqual({ removed: null, erased: null });
        // The removal came first and ended the share; the erasure found nothing standing.
        const share = await pool.query<{ ended_how: string }>(
          "SELECT ended_how FROM contact_share WHERE conversation_id = $1",
          [id],
        );
        expect(share.rows).toEqual([{ ended_how: "removed" }]);
        const account = await pool.query<{ state: string }>(
          "SELECT state FROM account WHERE id = $1",
          [a],
        );
        expect(account.rows[0]?.state).toBe("deleted");
        const left = await pool.query("SELECT 1 FROM contact WHERE account_id = $1", [a]);
        expect(left.rows).toEqual([]);
      } finally {
        removing.release();
        erasing.release();
        await pool.end();
      }
    });
  });
});

describe("a share against the night's archive", () => {
  it("a share that commits while the night waits for its conversation keeps it out of the archive", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({
        connectionString: url,
        max: 4,
        applicationName: "kuutti-share-night",
      });
      const sharing = await pool.connect();
      const archiving = await pool.connect();
      try {
        await migrate(pool, MIGRATIONS);
        const { a, id } = await twoInAConversation(pool, "kuutti share night");
        // Opened a month ago and silent since: the night's, but for the share.
        await pool.query(
          "UPDATE conversation SET opened_at = now() - interval '30 days' WHERE id = $1",
          [id],
        );
        await pool.query(
          "INSERT INTO contact (account_id, kind, value) VALUES ($1, 'phone', '+358401234567')",
          [a],
        );
        const { logger } = await captureLogger();
        const now = () => new Date();
        const sharePid = await pidOf(sharing);
        const nightPid = await pidOf(archiving);
        // The share holds the conversation's row and has written the share, not yet committed.
        await sharing.query("BEGIN");
        await shareContact(
          { db: sharing, logger, now },
          { accountId: a, conversationId: id, kind: "phone" },
        );
        await archiving.query("BEGIN");
        const night = watched(archiveSilentConversations({ db: archiving, logger, now }));
        const waited = await waitsFor(pool, nightPid, sharePid, night.settled);
        await sharing.query("COMMIT");
        const archived = await night.outcome;
        await archiving.query(typeof archived === "number" ? "COMMIT" : "ROLLBACK");
        expect(waited).toBe(true);
        expect(archived).toBe(0);
        const row = await pool.query<{ archived: boolean }>(
          "SELECT archived_at IS NOT NULL AS archived FROM conversation WHERE id = $1",
          [id],
        );
        expect(row.rows[0]?.archived).toBe(false);
      } finally {
        sharing.release();
        archiving.release();
        await pool.end();
      }
    });
  });
});
