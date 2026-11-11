import { resolve } from "node:path";
import { createPool, migrate, TEST_DATABASE_URL } from "@kuutti/db";
import { ensureEventPartitions } from "../research/index.ts";

/** The committed migrations, from which every test database is built. */
export const MIGRATIONS = resolve(import.meta.dirname, "../../../../packages/db/drizzle");

/**
 * Where the tests that stop the clock stop it. Their events need that month's
 * partition whatever day the run falls on: made from the wall clock alone, a
 * fresh database on 1 November 2026 had no October, and the events of those
 * tests went nowhere, since a failed event never fails a request.
 */
export const STOPPED_CLOCK = new Date("2026-10-16T09:00:00.000Z");

/** Runs once per test run: the test database carries every committed migration and, as after a boot, this month's and next month's events partitions. */
export default async function setup(): Promise<void> {
  const pool = createPool({
    connectionString: TEST_DATABASE_URL,
    max: 1,
    applicationName: "kuutti-api-test-setup",
  });
  try {
    await migrate(pool, MIGRATIONS);
    await ensureEventPartitions(pool, new Date());
    await ensureEventPartitions(pool, STOPPED_CLOCK);
  } finally {
    await pool.end();
  }
}
