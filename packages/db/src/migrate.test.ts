import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { ConfigKeyName, ConfigVersion } from "@kuutti/schema";
import { describe, expect, it } from "vitest";
import { readJournal } from "./journal.ts";
import { migrate } from "./migrate.ts";
import { migrationsStatus } from "./migrations.ts";
import { createPool, type Queryable } from "./pool.ts";
import { MATCHING_CONFIG_V1 } from "./seed.ts";
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

  it("carries matching_config's version 1, the same rows as the seed, and no later version", async () => {
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
        expect(rows.filter((r) => r.version !== 1)).toEqual([]);
      } finally {
        await pool.end();
      }
    });
  });

  it("starts a database with the one pond, closed, the tunables, and no other row (ADR-060, ADR-061 §8)", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      try {
        await migrate(pool, MIGRATIONS);
        const ponds = await pool.query("SELECT slug, name_nominative, matching_open FROM ponds");
        expect(ponds.rows).toEqual([
          { slug: "suomi", name_nominative: "Suomi", matching_open: false },
        ]);
        const { rows: tables } = await pool.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`,
        );
        const holding: Record<string, number> = {};
        for (const { table_name: table } of tables) {
          const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM "${table}"`);
          if (Number(rows[0]?.n) > 0) holding[table] = Number(rows[0]?.n);
        }
        expect(holding).toEqual({
          matching_config: Object.keys(MATCHING_CONFIG_V1).length,
          ponds: 1,
        });
      } finally {
        await pool.end();
      }
    });
  });

  it("writes every row so that it reads in the panel as a version without a reason, and a later version may carry one (#304, #305)", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      try {
        await migrate(pool, MIGRATIONS);
        const { rows } = await pool.query<{
          key: string;
          version: number;
          value: unknown;
          valid_from: Date;
          created_by: string;
          reason: string | null;
        }>("SELECT key, version, value, valid_from, created_by, reason FROM matching_config");
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row.reason, row.key).toBeNull();
          expect(ConfigKeyName.safeParse(row.key).success, row.key).toBe(true);
          expect(
            ConfigVersion.safeParse({
              version: row.version,
              value: row.value,
              validFrom: row.valid_from.toISOString(),
              createdBy: row.created_by,
              reason: row.reason,
            }).error,
            row.key,
          ).toBeUndefined();
        }

        // A row without a reason is still written, as the seed writes one; the panel's carries its reason.
        await pool.query(
          `INSERT INTO matching_config (version, key, value, created_by)
           VALUES (2, 'stars_max', '12'::jsonb, 'seed')`,
        );
        await pool.query(
          `INSERT INTO matching_config (version, key, value, created_by, reason)
           VALUES (2, 'inbox_stop', '25'::jsonb, 'admin', 'Smaller piles first')`,
        );
        const written = await pool.query<{ key: string; reason: string | null }>(
          `SELECT key, reason FROM matching_config WHERE version = 2 ORDER BY key`,
        );
        expect(written.rows).toEqual([
          { key: "inbox_stop", reason: "Smaller piles first" },
          { key: "stars_max", reason: null },
        ]);
      } finally {
        await pool.end();
      }
    });
  });

  it("refuses a database whose journal still ends at the chain folded into the baseline, leaves it as it was, and has nothing to apply once its journal is stamped (ADR-065)", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      try {
        await migrate(pool, MIGRATIONS);
        await accountOf(pool, "9");
        const journal = () =>
          pool.query<{ hash: string; created_at: string }>(
            "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at",
          );
        const stamped = (await journal()).rows;
        // 0109_pond_counter_finished, the chain's last, as the journal of a database that ran it ends.
        await pool.query("DELETE FROM drizzle.__drizzle_migrations");
        await pool.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('the chain', 1793827411048)",
        );
        const before = await pool.query("SELECT count(*) AS n FROM matching_config");

        await expect(migrate(pool, MIGRATIONS)).rejects.toMatchObject({
          cause: { code: "42710" },
        });

        expect((await journal()).rows).toEqual([
          { hash: "the chain", created_at: "1793827411048" },
        ]);
        expect((await pool.query("SELECT count(*) AS n FROM matching_config")).rows).toEqual(
          before.rows,
        );
        expect((await pool.query("SELECT count(*) AS n FROM account")).rows).toEqual([{ n: "1" }]);
        const journalNames = (readJournal(MIGRATIONS) ?? []).map((entry) => entry.tag);
        expect(await migrationsStatus(pool, MIGRATIONS)).toEqual({
          state: "pending",
          applied: 0,
          pending: journalNames,
        });

        // The way across where the schema is the one the chain left: the folder's own rows in the journal.
        await pool.query("DELETE FROM drizzle.__drizzle_migrations");
        for (const row of stamped) {
          await pool.query(
            "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
            [row.hash, row.created_at],
          );
        }
        expect(await migrate(pool, MIGRATIONS)).toEqual({ state: "nothing-to-do", applied: 0 });
        expect((await migrationsStatus(pool, MIGRATIONS)).state).toBe("current");
        expect((await pool.query("SELECT count(*) AS n FROM account")).rows).toEqual([{ n: "1" }]);
      } finally {
        await pool.end();
      }
    });
  });

  const accountOf = async (pool: Queryable, n: string) => {
    const { rows } = await pool.query<{ id: string }>(
      `WITH i AS (INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id)
       INSERT INTO account (identity_id) SELECT id FROM i RETURNING id`,
      [n.repeat(64)],
    );
    return rows[0]?.id as string;
  };

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

  it("holds a sanction's end, note, lift and review together in the database (#307)", async () => {
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

  it("refuses a review with its time and who but without a note (#307)", async () => {
    // A review's note is one to 500 characters (ADR-024 §1); a missing one is not a review.
    await withSanctionTable(async (insert, { identityId }) => {
      await expect(insert({ reviewed_at: AT, reviewed_by: identityId })).rejects.toMatchObject(
        refused("sanction_review_check"),
      );
    });
  });

  it("holds an invitation open, redeemed or counted, a unit to its spending, and a notice to what it is about (#107)", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 1 });
      try {
        await migrate(pool, MIGRATIONS);
        const [inviter, friend, other] = [
          await accountOf(pool, "6"),
          await accountOf(pool, "7"),
          await accountOf(pool, "8"),
        ];
        let codes = 0;
        const invite = (row: Record<string, unknown> = {}) => {
          codes += 1;
          const full = {
            inviter_account_id: inviter,
            code_hash: String(codes).padStart(64, "0"),
            ...row,
          };
          const columns = Object.keys(full);
          return pool.query<{ id: string }>(
            `INSERT INTO invitation (${columns.join(", ")})
             VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
            Object.values(full),
          );
        };

        // Open is nothing set; redeemed is when and by whom; counted only once redeemed.
        await invite();
        for (const half of [
          { redeemed_by_account_id: friend },
          { redeemed_at: AT },
          { counted_at: AT },
          { redeemed_by_account_id: friend, counted_at: AT },
        ]) {
          await expect(invite(half)).rejects.toMatchObject(refused("invitation_redeemed_check"));
        }
        await expect(
          invite({ redeemed_by_account_id: inviter, redeemed_at: AT }),
        ).rejects.toMatchObject(refused("invitation_not_self_check"));
        const used = await invite({
          redeemed_by_account_id: friend,
          redeemed_at: AT,
          counted_at: AT,
        });
        const usedId = used.rows[0]?.id as string;
        // A person redeems one invitation, ever, and a code names one invitation.
        await expect(
          invite({ redeemed_by_account_id: friend, redeemed_at: AT }),
        ).rejects.toMatchObject({ code: "23505", constraint: "invitation_redeemed_by_idx" });
        await expect(
          pool.query("INSERT INTO invitation (inviter_account_id, code_hash) VALUES ($1, $2)", [
            other,
            "1".padStart(64, "0"),
          ]),
        ).rejects.toMatchObject({ code: "23505", constraint: "invitation_code_hash_idx" });
        // A counted one keeps its count when its redeemer is erased.
        await pool.query("UPDATE invitation SET redeemed_by_account_id = NULL WHERE id = $1", [
          usedId,
        ]);
        // A redeemed one stays for its redeemer when its inviter is erased, the
        // self check passing on the null; an open one, or one naming nobody, does not.
        const joined = await invite({ redeemed_by_account_id: other, redeemed_at: AT });
        await pool.query("UPDATE invitation SET inviter_account_id = NULL WHERE id = $1", [
          joined.rows[0]?.id,
        ]);
        await expect(invite({ inviter_account_id: null })).rejects.toMatchObject(
          refused("invitation_named_check"),
        );
        await expect(
          pool.query("UPDATE invitation SET inviter_account_id = NULL WHERE id = $1", [usedId]),
        ).rejects.toMatchObject(refused("invitation_named_check"));
        await pool.query("DELETE FROM invitation WHERE id = $1", [joined.rows[0]?.id]);

        // A unit spent on an entry has its time, and outlives the entry without the link.
        const { rows: rounds } = await pool.query<{ id: string }>(
          "INSERT INTO rounds (account_id, day) VALUES ($1, '2026-10-22') RETURNING id",
          [inviter],
        );
        const { rows: entries } = await pool.query<{ id: string }>(
          `INSERT INTO round_entries (round_id, position, candidate_id, reason, decision, decided_at)
           VALUES ($1, 1, $2, 'matches_filters', 'like', $3) RETURNING id`,
          [rounds[0]?.id, other, AT],
        );
        const entryId = entries[0]?.id;
        await expect(
          pool.query(
            "INSERT INTO reward (account_id, kind, invitation_id, spent_entry_id) VALUES ($1, 'fish', $2, $3)",
            [inviter, usedId, entryId],
          ),
        ).rejects.toMatchObject(refused("reward_spent_check"));
        await pool.query(
          `INSERT INTO reward (account_id, kind, invitation_id, spent_at, spent_entry_id)
           VALUES ($1, 'fish', $2, $3, $4), ($1, 'fish', $2, NULL, NULL)`,
          [inviter, usedId, AT, entryId],
        );
        // Earned likes went with #503.
        for (const kind of ["boost", "like"]) {
          await expect(
            pool.query("INSERT INTO reward (account_id, kind, invitation_id) VALUES ($1, $3, $2)", [
              inviter,
              usedId,
              kind,
            ]),
          ).rejects.toMatchObject({ code: "22P02" });
        }
        await pool.query("DELETE FROM round_entries WHERE id = $1", [entryId]);
        const spent = await pool.query<{ kind: string; spent: boolean; entry: string | null }>(
          `SELECT kind, spent_at IS NOT NULL AS spent, spent_entry_id AS entry FROM reward
           ORDER BY spent_at NULLS LAST`,
        );
        expect(spent.rows).toEqual([
          { kind: "fish", spent: true, entry: null },
          { kind: "fish", spent: false, entry: null },
        ]);

        // An invitation's notice, either side's, points at its invitation, and only it does.
        const notice = (kind: string, invitationId: string | null) =>
          pool.query("INSERT INTO notice (account_id, kind, invitation_id) VALUES ($1, $2, $3)", [
            inviter,
            kind,
            invitationId,
          ]);
        for (const kind of ["invitation_counted", "invitation_friend"]) {
          await expect(notice(kind, null)).rejects.toMatchObject(
            refused("notice_invitation_check"),
          );
          await notice(kind, usedId);
        }
        await expect(notice("warning", usedId)).rejects.toMatchObject({ code: "23514" });

        // The units and the notice go with their invitation.
        await pool.query("DELETE FROM invitation WHERE id = $1", [usedId]);
        const left = await pool.query<{ rewards: string; notices: string }>(
          `SELECT (SELECT count(*) FROM reward) AS rewards, (SELECT count(*) FROM notice) AS notices`,
        );
        expect(left.rows).toEqual([{ rewards: "0", notices: "0" }]);
      } finally {
        await pool.end();
      }
    });
  });

  it("holds a session to a family hash of its own (#490, ADR-059)", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 1 });
      try {
        await migrate(pool, MIGRATIONS);
        const accountId = await accountOf(pool, "a");
        const insert = (family: string | null, refresh: string) =>
          pool.query(
            `INSERT INTO session (account_id, platform, access_hash, access_expires_at, refresh_hash, family_hash, expires_at)
             VALUES ($1, 'ios', $2, now() + interval '15 minutes', $2, $3, now() + interval '90 days')`,
            [accountId, refresh, family],
          );
        await insert("f1", "r1");
        await expect(insert(null, "r2")).rejects.toMatchObject({ code: "23502" });
        await expect(insert("f1", "r3")).rejects.toMatchObject({
          code: "23505",
          constraint: "session_family_hash_unique",
        });
      } finally {
        await pool.end();
      }
    });
  });

  it("lets only a pass carry the second pass's mark (#502, ADR-062 §6)", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 1 });
      try {
        await migrate(pool, MIGRATIONS);
        const [one, other] = [await accountOf(pool, "b"), await accountOf(pool, "c")];
        const { rows: rounds } = await pool.query<{ id: string }>(
          "INSERT INTO rounds (account_id, day) VALUES ($1, '2026-10-30') RETURNING id",
          [one],
        );
        await pool.query(
          `INSERT INTO round_entries (round_id, position, candidate_id, reason, decision, decided_at)
           VALUES ($1, 1, $2, 'matches_filters', 'pass', now())`,
          [rounds[0]?.id, other],
        );
        // A pass is a first pass until it says otherwise.
        const entries = await pool.query("SELECT second_pass FROM round_entries");
        expect(entries.rows).toEqual([{ second_pass: false }]);
        const mark = (value: boolean, decision: string) =>
          pool.query(
            "UPDATE round_entries SET decision = $2::round_decision, second_pass = $1 RETURNING second_pass",
            [value, decision],
          );
        expect((await mark(true, "pass")).rows).toEqual([{ second_pass: true }]);
        expect((await mark(false, "skip")).rows).toEqual([{ second_pass: false }]);
        for (const decision of ["like", "skip"]) {
          await expect(mark(true, decision), decision).rejects.toThrow(
            /round_entries_second_pass_check/,
          );
        }
      } finally {
        await pool.end();
      }
    });
  });

  it("stands a counter's row that names no number at zero, and never at null (#581)", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 1 });
      try {
        await migrate(pool, MIGRATIONS);
        const { rows } = await pool.query<{ finished: number }>(
          `INSERT INTO pond_counter (pond_id, day)
           SELECT id, '2026-11-04' FROM ponds WHERE slug = 'suomi' RETURNING finished`,
        );
        expect(rows).toEqual([{ finished: 0 }]);
        await expect(pool.query("UPDATE pond_counter SET finished = NULL")).rejects.toMatchObject({
          code: "23502",
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
          "account_export",
          "admin_session",
          "audit_log",
          "auth_request",
          "block",
          "card_shown",
          "consent",
          "contact",
          "contact_share",
          "conversation",
          "conversation_participant",
          "email_code",
          "email_send",
          "events",
          "feedback",
          "found_them_count",
          "identity",
          "invitation",
          "matching_config",
          "message",
          "moderator_roles",
          "notice",
          "notification_preference",
          "photo",
          "photo_access",
          "photo_check_note",
          "photo_review",
          "pond_counter",
          "ponds",
          "preferences",
          "profile",
          "push_token",
          "report",
          "report_message",
          "research_subject",
          "reward",
          "round_entries",
          "round_relaxation",
          "rounds",
          "sanction",
          "session",
          "star",
        ]);
      } finally {
        await pool.end();
      }
    });
  });
});
