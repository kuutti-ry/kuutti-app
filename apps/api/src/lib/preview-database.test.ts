import { createPool, type Queryable } from "@kuutti/db";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL } from "../test/harness.ts";
import { ensurePreviewDatabase } from "./preview-database.ts";

describe("ensurePreviewDatabase", () => {
  // Needs CREATEDB on the test role, which compose and the CI service grant.
  const admin = createPool({ connectionString: TEST_DATABASE_URL, max: 1 });
  // Unique per worker without random data (CLAUDE.md Testing): the process id.
  const name = `kuutti_pr_${process.pid % 1_000_000}`;

  // Another name for the race, apart from the one above and from boot.test.ts (an 8 in front).
  const raced = `kuutti_pr_8${String(process.pid % 1_000_000).padStart(6, "0")}`;
  // The other container: a connection of its own.
  const other = createPool({ connectionString: TEST_DATABASE_URL, max: 1 });

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${raced} WITH (FORCE)`);
    await admin.end();
    await other.end();
  });

  it("creates the database once and reports it afterwards", async () => {
    expect(await ensurePreviewDatabase(admin, name)).toBe("created");
    expect(await ensurePreviewDatabase(admin, name)).toBe("exists");
    const row = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    expect(row.rowCount).toBe(1);
  });

  it("refuses a name outside the preview pattern before touching the database", async () => {
    await expect(ensurePreviewDatabase(admin, "kuutti")).rejects.toThrow(
      /not a preview database name/,
    );
    await expect(ensurePreviewDatabase(admin, 'kuutti_pr_1"; DROP DATABASE x')).rejects.toThrow(
      /not a preview database name/,
    );
  });

  it("a second container that creates the database between the check and the create is the same outcome: it exists", async () => {
    // The check is the real one and finds nothing; before our CREATE, the other container's lands.
    const racing: Queryable = {
      query: (async (text: string, values?: unknown[]) => {
        const result = await admin.query(text, values);
        if (text.startsWith("SELECT 1 FROM pg_database")) {
          await other.query(`CREATE DATABASE ${raced}`);
        }
        return result;
      }) as Queryable["query"],
    };
    expect(await ensurePreviewDatabase(racing, raced)).toBe("exists");
    const row = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [raced]);
    expect(row.rowCount).toBe(1);
  });

  it("any other failure of the create is thrown, not taken for an existing database", async () => {
    // CREATE DATABASE cannot run inside a transaction: Postgres refuses with 25001.
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      const error = await ensurePreviewDatabase(client, "kuutti_pr_7777777").then(
        () => null,
        (e: unknown) => e,
      );
      expect((error as { code?: string }).code).toBe("25001");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    const row = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'kuutti_pr_7777777'");
    expect(row.rowCount).toBe(0);
  });
});
