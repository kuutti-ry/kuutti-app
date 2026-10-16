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

  it("migration 0037 takes the coffee party out of stored politics and leaves none of them alone (#239)", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 1 });
      try {
        await migrate(pool, MIGRATIONS);
        // Answers written while the registry still listed the coffee party and allowed a mix.
        const stored: Record<string, Record<string, unknown>> = {
          joke: { politics: ["kahvipuolue"], smoking: "never" },
          jokeAmong: { politics: ["vihr", "kahvipuolue", "sdp"] },
          mix: { politics: ["none_of_them", "kok"] },
          all: { politics: ["kok", "none_of_them", "kahvipuolue"] },
          noneAndJoke: { politics: ["none_of_them", "kahvipuolue"] },
          none: { politics: ["none_of_them"] },
          parties: { politics: ["vas", "vihr"] },
          unanswered: { religion: "atheist" },
          empty: {},
        };
        const ids: Record<string, string> = {};
        for (const [index, [name, fields]] of Object.entries(stored).entries()) {
          const identity = await pool.query<{ id: string }>(
            "INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id",
            [index.toString(16).padStart(64, "e")],
          );
          const account = await pool.query<{ id: string }>(
            "INSERT INTO account (identity_id) VALUES ($1) RETURNING id",
            [identity.rows[0]?.id],
          );
          ids[name] = account.rows[0]?.id ?? "";
          await pool.query(
            `INSERT INTO profile (account_id, display_name, bio, bio_preset, fields, prompts, created_at, updated_at)
             VALUES ($1, 'A', NULL, NULL, $2::jsonb, '[]'::jsonb, now(), now())`,
            [ids[name], JSON.stringify(fields)],
          );
        }
        const sql = readFileSync(resolve(MIGRATIONS, "0037_politics_options.sql"), "utf8");
        const after = async () => {
          const rows = await pool.query<{ account_id: string; fields: Record<string, unknown> }>(
            "SELECT account_id, fields FROM profile",
          );
          const byId = new Map(rows.rows.map((row) => [row.account_id, row.fields]));
          return Object.fromEntries(
            Object.keys(stored).map((name) => [name, byId.get(ids[name] ?? "")]),
          );
        };
        const expected = {
          joke: { smoking: "never" },
          jokeAmong: { politics: ["vihr", "sdp"] },
          mix: { politics: ["kok"] },
          all: { politics: ["kok"] },
          noneAndJoke: { politics: ["none_of_them"] },
          none: { politics: ["none_of_them"] },
          parties: { politics: ["vas", "vihr"] },
          unanswered: { religion: "atheist" },
          empty: {},
        };
        await pool.query(sql);
        expect(await after()).toEqual(expected);
        // Idempotent: a second run changes nothing.
        await pool.query(sql);
        expect(await after()).toEqual(expected);
      } finally {
        await pool.end();
      }
    });
  });

  /**
   * A migrated temporary database with one identity and account, and an
   * insert of a sanction row that defaults to a plain warning.
   */
  async function withSanctionTable(
    fn: (
      insert: (row: Record<string, unknown>) => Promise<unknown>,
      ids: { identityId: string; pool: ReturnType<typeof createPool> },
    ) => Promise<void>,
  ) {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 1 });
      try {
        await migrate(pool, MIGRATIONS);
        const identity = await pool.query<{ id: string }>(
          "INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id",
          ["5".repeat(64)],
        );
        const identityId = identity.rows[0]?.id ?? "";
        const account = await pool.query<{ id: string }>(
          "INSERT INTO account (identity_id) VALUES ($1) RETURNING id",
          [identityId],
        );
        const accountId = account.rows[0]?.id;
        const insert = (row: Record<string, unknown>) => {
          const full = {
            identity_id: identityId,
            account_id: accountId,
            kind: "warn",
            reason: "other",
            note: "x",
            ...row,
          };
          const columns = Object.keys(full);
          return pool.query(
            `INSERT INTO sanction (${columns.join(", ")})
             VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
            Object.values(full),
          );
        };
        await fn(insert, { identityId, pool });
      } finally {
        await pool.end();
      }
    });
  }
  const refused = (constraint: string) => ({ code: "23514", constraint });
  const END = "2026-10-21T21:00:00Z";
  const AT = "2026-10-20T09:00:00Z";

  it("migration 0046 holds a sanction's end, note, lift and review together in the database (#307)", async () => {
    await withSanctionTable(async (insert, { identityId, pool }) => {
      // Only a suspension has an end, and a suspension always has one.
      await expect(insert({ kind: "suspend" })).rejects.toMatchObject(
        refused("sanction_ends_at_check"),
      );
      for (const kind of ["warn", "shadow_ban", "ban"]) {
        await expect(insert({ kind, ends_at: END })).rejects.toMatchObject(
          refused("sanction_ends_at_check"),
        );
      }
      await insert({ kind: "suspend", ends_at: END });
      // The note: one to 500 characters.
      await expect(insert({ note: "" })).rejects.toMatchObject(refused("sanction_note_check"));
      await expect(insert({ note: "x".repeat(501) })).rejects.toMatchObject(
        refused("sanction_note_check"),
      );
      await insert({ note: "x".repeat(500) });
      // A lift by somebody has its time; a lift by nobody (the night) only the time.
      await expect(insert({ lifted_by: identityId })).rejects.toMatchObject(
        refused("sanction_lift_check"),
      );
      await insert({ lifted_at: AT });
      await insert({ lifted_at: AT, lifted_by: identityId });
      // A review is the time, who, and a note of one to 500 characters, all or none.
      for (const half of [
        { reviewed_at: AT },
        { reviewed_by: identityId },
        { review_note: "kept" },
        { reviewed_at: AT, reviewed_by: identityId, review_note: "" },
        { reviewed_at: AT, reviewed_by: identityId, review_note: "x".repeat(501) },
      ]) {
        await expect(insert(half)).rejects.toMatchObject(refused("sanction_review_check"));
      }
      await insert({ reviewed_at: AT, reviewed_by: identityId, review_note: "kept" });
      const kept = await pool.query<{ n: string }>("SELECT count(*) AS n FROM sanction");
      expect(Number(kept.rows[0]?.n)).toBe(5);
      // The kinds and the reasons are the database's own enums.
      await expect(insert({ kind: "mute" })).rejects.toMatchObject({ code: "22P02" });
      await expect(insert({ reason: "spam" })).rejects.toMatchObject({ code: "22P02" });
    });
  });

  it("migration 0046 refuses a review with its time and who but without a note (#307)", async () => {
    // A review's note is one to 500 characters (ADR-024 §1); a missing one is not a review.
    await withSanctionTable(async (insert, { identityId }) => {
      await expect(insert({ reviewed_at: AT, reviewed_by: identityId })).rejects.toMatchObject(
        refused("sanction_review_check"),
      );
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
          "account_export",
          "admin_session",
          "audit_log",
          "auth_request",
          "card_shown",
          "consent",
          "events",
          "feedback",
          "gate",
          "identity",
          "matching_config",
          "moderator_roles",
          "photo",
          "photo_access",
          "photo_check_note",
          "photo_review",
          "ponds",
          "preferences",
          "profile",
          "research_subject",
          "sanction",
          "session",
          "waitlist_snapshot",
        ]);
      } finally {
        await pool.end();
      }
    });
  });
});
