import type { Queryable } from "@kuutti/db";
import { expect } from "vitest";
import { eraseAccount } from "../identity/index.ts";
import { signedInAccount } from "./account.ts";
import { captureLogger } from "./harness.ts";
import { pidOf, waitsFor, watched, withTwoConnections } from "./races.ts";

/** TD-7: hold a real erasure open while a child writer reaches its account check. */
export async function withErasureRace<T>(
  finish: "COMMIT" | "ROLLBACK",
  write: (db: Queryable, accountId: string) => Promise<T>,
  check: (db: Queryable, accountId: string, result: T | string) => Promise<void>,
  prepare?: (db: Queryable, accountId: string) => Promise<unknown>,
): Promise<void> {
  await withTwoConnections("account-child-erasure", async (pool, erasing, writing) => {
    const account = await signedInAccount(pool, "account-child-erasure");
    const { logger } = await captureLogger();
    await prepare?.(pool, account.accountId);
    const erasingPid = await pidOf(erasing);
    const writingPid = await pidOf(writing);
    await erasing.query("BEGIN");
    await writing.query("BEGIN");
    await writing.query("SET LOCAL statement_timeout = '5s'");
    let pending: ReturnType<typeof watched<T>> | undefined;
    try {
      await eraseAccount(
        { db: erasing, logger, now: () => new Date("2026-11-06T10:00:00Z") },
        account.accountId,
      );
      pending = watched(write(writing, account.accountId));
      expect(await waitsFor(pool, writingPid, erasingPid, pending.settled)).toBe(true);
      await erasing.query(finish);
      const result = await pending.outcome;
      await writing.query("COMMIT");
      await check(pool, account.accountId, result);
      const state = await pool.query("SELECT state FROM account WHERE id = $1", [
        account.accountId,
      ]);
      expect(state.rows[0]?.state).toBe(finish === "COMMIT" ? "deleted" : "active");
    } finally {
      await erasing.query("ROLLBACK");
      await pending?.outcome;
      await writing.query("ROLLBACK");
    }
  });
}
