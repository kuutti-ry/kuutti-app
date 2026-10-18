import type { Queryable } from "@kuutti/db";

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
