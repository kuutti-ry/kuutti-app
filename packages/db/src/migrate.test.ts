import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readJournal } from "./journal.ts";
import { migrate } from "./migrate.ts";
import { migrationsStatus } from "./migrations.ts";
import { createPool } from "./pool.ts";
import { MATCHING_CONFIG_V1, MATCHING_CONFIG_V2 } from "./seed.ts";
import { withTemporaryDatabase } from "./test/temporary-database.ts";

const MIGRATIONS = resolve(import.meta.dirname, "..", "drizzle");

function runMigrateCli(
  databaseUrl: string,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli/migrate.ts"], {
      cwd: resolve(import.meta.dirname, ".."),
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: databaseUrl },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString();
    });
    child.on("close", (code) => done({ code, out, err }));
  });
}

describe("migrate", () => {
  it("two processes started at once against an empty database both exit 0 and apply each migration once", async () => {
    await withTemporaryDatabase(async (url) => {
      const [a, b] = await Promise.all([runMigrateCli(url), runMigrateCli(url)]);
      expect(a.code, a.err).toBe(0);
      expect(b.code, b.err).toBe(0);
      const states = [a.out, b.out].map((o) => (JSON.parse(o) as { state: string }).state).sort();
      expect(states).toEqual(["applied", "nothing-to-do"]);

      const pool = createPool({ connectionString: url, max: 1 });
      try {
        const journal = readJournal(MIGRATIONS) ?? [];
        const rows = await pool.query<{ n: string }>(
          "SELECT count(*) AS n FROM drizzle.__drizzle_migrations",
        );
        expect(Number(rows.rows[0]?.n)).toBe(journal.length);
        expect((await migrationsStatus(pool, MIGRATIONS)).state).toBe("current");
      } finally {
        await pool.end();
      }
    });
  });

  it("carries matching_config versions 1 and 2, the same rows as the seed", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      try {
        await migrate(pool, MIGRATIONS);
        const { rows } = await pool.query<{ key: string; value: unknown; version: number }>(
          "SELECT key, value, version FROM matching_config ORDER BY key, version",
        );
        const at = (version: number) =>
          Object.fromEntries(
            rows.filter((r) => r.version === version).map((r) => [r.key, r.value]),
          );
        expect(at(1)).toEqual(MATCHING_CONFIG_V1);
        expect(at(2)).toEqual(MATCHING_CONFIG_V2);
      } finally {
        await pool.end();
      }
    });
  });

  it("migration 0026 turns a stored single field or line of work into an array and leaves arrays alone (#178)", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 1 });
      try {
        await migrate(pool, MIGRATIONS);
        // A profile written before the registry made the two fields multi-choice (ADR-019 §1, amended).
        const identity = await pool.query<{ id: string }>(
          "INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id",
          ["f".repeat(64)],
        );
        const account = await pool.query<{ id: string }>(
          "INSERT INTO account (identity_id) VALUES ($1) RETURNING id",
          [identity.rows[0]?.id],
        );
        const accountId = account.rows[0]?.id;
        await pool.query(
          `INSERT INTO profile (account_id, display_name, bio, bio_preset, fields, prompts, created_at, updated_at)
           VALUES ($1, 'A', NULL, NULL, $2::jsonb, '[]'::jsonb, now(), now())`,
          [accountId, JSON.stringify({ field: "arts", occupation: ["science"], smoking: "never" })],
        );
        const sql = readFileSync(
          resolve(MIGRATIONS, "0026_profile_fields_multi_occupation_field.sql"),
          "utf8",
        );
        const fields = async () =>
          (
            await pool.query<{ fields: Record<string, unknown> }>(
              "SELECT fields FROM profile WHERE account_id = $1",
              [accountId],
            )
          ).rows[0]?.fields;
        await pool.query(sql);
        expect(await fields()).toEqual({
          field: ["arts"],
          occupation: ["science"],
          smoking: "never",
        });
        // Idempotent: a second run changes nothing.
        await pool.query(sql);
        expect(await fields()).toEqual({
          field: ["arts"],
          occupation: ["science"],
          smoking: "never",
        });
      } finally {
        await pool.end();
      }
    });
  });

  it("is a no-op the second time", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      try {
        expect((await migrate(pool, MIGRATIONS)).state).toBe("applied");
        expect((await migrate(pool, MIGRATIONS)).state).toBe("nothing-to-do");
        const tables = await pool.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
        );
        expect(tables.rows.map((r) => r.table_name)).toEqual([
          "account",
          "admin_session",
          "audit_log",
          "auth_request",
          "card_shown",
          "consent",
          "events",
          "gate",
          "identity",
          "matching_config",
          "moderator_roles",
          "photo",
          "photo_access",
          "photo_review",
          "ponds",
          "preferences",
          "profile",
          "research_subject",
          "session",
          "waitlist_snapshot",
        ]);
      } finally {
        await pool.end();
      }
    });
  });
});
