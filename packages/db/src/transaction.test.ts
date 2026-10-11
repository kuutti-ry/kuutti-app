import { afterAll, describe, expect, it } from "vitest";
import { createPool, type PoolClient, type Queryable, transaction } from "./index.ts";

// The unit-of-work seam (#49): commit, rollback on a throw, and a savepoint
// when the caller is already inside a transaction, which is how every route
// runs under the API's test harness.

const URL = process.env.DATABASE_URL ?? "postgres://kuutti:kuutti@127.0.0.1:5432/kuutti_test";
const pool = createPool({ connectionString: URL, max: 2, applicationName: "kuutti-db-test" });
afterAll(() => pool.end());

describe("transaction", () => {
  it("commits on a pool, rolls back when the function throws", async () => {
    await pool.query("CREATE TEMP TABLE IF NOT EXISTS tx_probe (n int)");
    // A temp table is per connection; use a real one for the pool case.
    await pool.query("CREATE TABLE IF NOT EXISTS tx_probe_pool (n int)");
    try {
      await transaction(pool, async (tx) => {
        await tx.query("INSERT INTO tx_probe_pool VALUES (1)");
      });
      await expect(
        transaction(pool, async (tx) => {
          await tx.query("INSERT INTO tx_probe_pool VALUES (2)");
          throw new Error("no");
        }),
      ).rejects.toThrow("no");
      const { rows } = await pool.query<{ n: number }>("SELECT n FROM tx_probe_pool ORDER BY n");
      expect(rows.map((r) => r.n)).toEqual([1]);
    } finally {
      await pool.query("DROP TABLE IF EXISTS tx_probe_pool");
    }
  });

  it("is a savepoint inside an open transaction: an inner failure keeps the outer work", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE TEMP TABLE tx_probe_sp (n int) ON COMMIT DROP");
      await client.query("INSERT INTO tx_probe_sp VALUES (1)");
      await expect(
        transaction(client, async (tx) => {
          await tx.query("INSERT INTO tx_probe_sp VALUES (2)");
          throw new Error("inner");
        }),
      ).rejects.toThrow("inner");
      await transaction(client, async (tx) => {
        await tx.query("INSERT INTO tx_probe_sp VALUES (3)");
      });
      const { rows } = await client.query<{ n: number }>("SELECT n FROM tx_probe_sp ORDER BY n");
      expect(rows.map((r) => r.n)).toEqual([1, 3]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});

describe("the pool", () => {
  it("names itself kuutti, holds ten connections and waits five seconds for one, unless told otherwise", async () => {
    const plain = createPool({ connectionString: URL });
    const tuned = createPool({
      connectionString: URL,
      max: 3,
      applicationName: "kuutti-probe",
      connectionTimeoutMillis: 250,
    });
    try {
      expect(plain.options).toMatchObject({
        max: 10,
        application_name: "kuutti",
        connectionTimeoutMillis: 5_000,
      });
      expect(tuned.options).toMatchObject({
        max: 3,
        application_name: "kuutti-probe",
        connectionTimeoutMillis: 250,
      });
      const name = async (db: Queryable) =>
        (await db.query<{ name: string }>("SELECT current_setting('application_name') AS name"))
          .rows[0]?.name;
      expect(await name(plain)).toBe("kuutti");
      expect(await name(tuned)).toBe("kuutti-probe");
    } finally {
      await plain.end();
      await tuned.end();
    }
  });
});

describe("a transaction whose rollback fails", () => {
  it("throws the error of the work, and discards the connection instead of returning it to the pool", async () => {
    const own = createPool({ connectionString: URL, max: 1 });
    try {
      await expect(
        transaction(own, async (tx) => {
          // The connection goes away under the work, so ROLLBACK cannot be sent.
          await (tx as PoolClient).end();
          throw new Error("the work failed");
        }),
      ).rejects.toThrow("the work failed");
      expect(own.totalCount).toBe(0);
      // The next unit of work gets a fresh connection that works.
      await expect(
        transaction(own, async (tx) => (await tx.query("SELECT 1 AS one")).rows),
      ).resolves.toEqual([{ one: 1 }]);
    } finally {
      await own.end();
    }
  });

  it("inside an open transaction, throws the error of the work when its savepoint is gone", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expect(
        transaction(client, async (tx) => {
          // The work ends the outer transaction, and the savepoint with it.
          await tx.query("ROLLBACK");
          throw new Error("inner");
        }),
      ).rejects.toThrow("inner");
      // The connection is still usable outside any transaction.
      expect((await client.query("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
    } finally {
      client.release();
    }
  });
});
