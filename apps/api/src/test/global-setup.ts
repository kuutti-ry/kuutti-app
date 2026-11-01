import { resolve } from "node:path";
import { createPool, migrate } from "@kuutti/db";
import { ensureEventPartitions } from "../research/index.ts";

/**
 * The tests' fixed clocks stand here (`2026-10-16` and the like), and their
 * events need these months whenever the suite runs: a partition that is not
 * there drops an event with a warn line, so a run in November read nothing.
 */
const FIXED_CLOCKS = new Date("2026-10-01T00:00:00.000Z");

/** Runs once per test run: the test database carries every committed migration and, as after a boot, this month's and next month's events partitions, and those of the tests' fixed clocks. */
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "postgres://kuutti:kuutti@127.0.0.1:5432/kuutti_test";
  const pool = createPool({
    connectionString: url,
    max: 1,
    applicationName: "kuutti-api-test-setup",
  });
  try {
    await migrate(
      pool,
      resolve(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "drizzle"),
    );
    await ensureEventPartitions(pool, new Date());
    await ensureEventPartitions(pool, FIXED_CLOCKS);
  } finally {
    await pool.end();
  }
}
