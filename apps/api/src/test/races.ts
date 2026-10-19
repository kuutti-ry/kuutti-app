import { resolve } from "node:path";
import {
  createPool,
  migrate,
  type Pool,
  type PoolClient,
  type Queryable,
  withTemporaryDatabase,
} from "@kuutti/db";

// Races between connections on committed rows (#348, #103, #351): a piece
// of work watched as it runs, and Postgres asked until one backend waits for
// a lock another holds (pg_blocking_pids, never a sleep). The work's
// connections are the test's own; ADR-021's deterministic interleaving.

export const codeOf = (error: unknown) => (error as { code?: string }).code ?? String(error);

export type Watched<T> = { outcome: Promise<T | string>; settled: () => boolean };

/** The work's outcome as a value, a failure as its code, and whether it has settled yet. */
export function watched<T>(work: Promise<T>): Watched<T> {
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

export async function pidOf(connection: Queryable): Promise<number> {
  const { rows } = await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return rows[0]?.pid as number;
}

/**
 * Asks Postgres until the waiter waits for a lock the holder holds (true),
 * or the waiter's work has settled without (false).
 */
export async function waitsFor(
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

const MIGRATIONS = resolve(import.meta.dirname, "../../../../packages/db/drizzle");

/**
 * A database of its own, migrated, with two connections held for the work
 * and a pool for its reads: committed rows the two can race on, which the
 * rolled-back transaction of an ordinary test cannot give (#351, #312).
 */
export async function withTwoConnections(
  name: string,
  work: (pool: Pool, first: PoolClient, second: PoolClient) => Promise<void>,
): Promise<void> {
  await withTemporaryDatabase(async (url) => {
    const pool = createPool({ connectionString: url, max: 4, applicationName: name });
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await migrate(pool, MIGRATIONS);
      await work(pool, first, second);
    } finally {
      first.release();
      second.release();
      await pool.end();
    }
  });
}
