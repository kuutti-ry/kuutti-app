import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readJournal } from "./journal.ts";
import { migrate } from "./migrate.ts";
import { migrationsStatus } from "./migrations.ts";
import { createPool, type Queryable } from "./pool.ts";
import { withTemporaryDatabase } from "./test/temporary-database.ts";

const neverQueried: Queryable = {
  query: () => {
    throw new Error("the database must not be touched when there is no journal");
  },
};

describe("readJournal", () => {
  it("returns null when no migration has been generated", () => {
    expect(readJournal(mkdtempSync(join(tmpdir(), "kuutti-db-")))).toBeNull();
  });

  it("returns the entries of a journal", () => {
    const dir = mkdtempSync(join(tmpdir(), "kuutti-db-"));
    mkdirSync(join(dir, "meta"));
    writeFileSync(
      join(dir, "meta", "_journal.json"),
      JSON.stringify({
        entries: [
          { idx: 0, version: "7", when: 1700000000000, tag: "0000_init", breakpoints: true },
        ],
      }),
    );
    expect(readJournal(dir)?.map((e) => e.tag)).toEqual(["0000_init"]);
  });
});

describe("migrationsStatus", () => {
  it("is current without a journal and does not open a connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kuutti-db-"));
    await expect(migrationsStatus(neverQueried, dir)).resolves.toEqual({
      state: "current",
      applied: 0,
      pending: [],
    });
  });
});

describe("a journal and the database it describes", () => {
  const MIGRATIONS = resolve(import.meta.dirname, "..", "drizzle");

  it("reads a journal without entries as no migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "kuutti-db-"));
    mkdirSync(join(dir, "meta"));
    writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ version: "7" }));
    expect(readJournal(dir)).toEqual([]);
  });

  it("is not migrated at all where no migration ran, and migrate has no journal to apply from an empty folder", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 1 });
      try {
        const journal = readJournal(MIGRATIONS) ?? [];
        expect(await migrationsStatus(pool, MIGRATIONS)).toEqual({
          state: "pending",
          applied: 0,
          pending: journal.map((entry) => entry.tag),
        });
        expect(await migrate(pool, mkdtempSync(join(tmpdir(), "kuutti-db-")))).toEqual({
          state: "no-journal",
          applied: 0,
        });
        // Nothing was created by that.
        const { rows } = await pool.query<{ present: boolean }>(
          "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present",
        );
        expect(rows[0]?.present).toBe(false);
      } finally {
        await pool.end();
      }
    });
  });

  it("counts every migration pending while the migrations table is empty", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 1 });
      try {
        await pool.query("CREATE SCHEMA drizzle");
        await pool.query(
          "CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
        );
        const status = await migrationsStatus(pool, MIGRATIONS);
        expect(status.state).toBe("pending");
        expect(status.applied).toBe(0);
        expect(status.pending).toHaveLength(readJournal(MIGRATIONS)?.length ?? -1);
      } finally {
        await pool.end();
      }
    });
  });

  it("names the migrations newer than the last one applied", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      try {
        await migrate(pool, MIGRATIONS);
        const journal = readJournal(MIGRATIONS) ?? [];
        const last = journal.at(-1);
        expect(await migrationsStatus(pool, MIGRATIONS)).toEqual({
          state: "current",
          applied: journal.length,
          pending: [],
        });
        // As if the newest migration had not run yet.
        await pool.query(
          "DELETE FROM drizzle.__drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM drizzle.__drizzle_migrations)",
        );
        expect(await migrationsStatus(pool, MIGRATIONS)).toEqual({
          state: "pending",
          applied: journal.length - 1,
          pending: [last?.tag],
        });
      } finally {
        await pool.end();
      }
    });
  });
});
