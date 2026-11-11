import type { Queryable } from "@kuutti/db";

/**
 * The account's row held until the transaction ends (`FOR SHARE`, as every
 * writer takes it), so an erasure either finishes first or waits; false when
 * the account is erased.
 */
export async function holdAccount(db: Queryable, accountId: string): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM account WHERE id = $1 AND state <> 'deleted' FOR SHARE",
    [accountId],
  );
  return rows.length > 0;
}

/**
 * The account's row locked (`FOR UPDATE`), the lock erasure takes first
 * (ADR-009 §8), so a write racing an erasure lands before its deletes or
 * sees the tombstone; false when the account is erased.
 */
export async function lockLiveAccount(db: Queryable, accountId: string): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM account WHERE id = $1 AND state <> 'deleted' FOR UPDATE",
    [accountId],
  );
  return rows.length > 0;
}

/** A lock on a name for the rest of the caller's transaction, released by its commit or rollback. */
export async function advisoryLock(db: Queryable, name: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [name]);
}

/** SELECT 1 under a hard timeout. Unreachable is a state, not an exception. */
export async function checkDb(db: Queryable, timeoutMs: number): Promise<"ok" | "unreachable"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"unreachable">((resolve) => {
    timer = setTimeout(() => resolve("unreachable"), timeoutMs);
  });
  try {
    return await Promise.race([db.query("SELECT 1 AS one").then((): "ok" => "ok"), timeout]);
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}
