import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigKeyName, ConfigVersion } from "@kuutti/schema";
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

  it("migration 0079 holds an invitation open, redeemed or counted, a unit to its spending, and a notice to what it is about, from an empty database in one transaction (#107)", async () => {
    // The whole folder in one transaction, as the migrator applies it: the
    // notice's check names the old kind, so the kind 0079 adds is never used
    // before its commit (ADR-044 §3).
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 1 });
      try {
        await migrate(pool, MIGRATIONS);
        const accountOf = async (n: string) => {
          const { rows } = await pool.query<{ id: string }>(
            `WITH i AS (INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id)
             INSERT INTO account (identity_id) SELECT id FROM i RETURNING id`,
            [n.repeat(64)],
          );
          return rows[0]?.id as string;
        };
        const [inviter, friend, other] = [
          await accountOf("6"),
          await accountOf("7"),
          await accountOf("8"),
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
            "INSERT INTO reward (account_id, kind, invitation_id, spent_entry_id) VALUES ($1, 'like', $2, $3)",
            [inviter, usedId, entryId],
          ),
        ).rejects.toMatchObject(refused("reward_spent_check"));
        await pool.query(
          `INSERT INTO reward (account_id, kind, invitation_id, spent_at, spent_entry_id)
           VALUES ($1, 'like', $2, $3, $4), ($1, 'fish', $2, NULL, NULL)`,
          [inviter, usedId, AT, entryId],
        );
        await expect(
          pool.query(
            "INSERT INTO reward (account_id, kind, invitation_id) VALUES ($1, 'boost', $2)",
            [inviter, usedId],
          ),
        ).rejects.toMatchObject({ code: "22P02" });
        await pool.query("DELETE FROM round_entries WHERE id = $1", [entryId]);
        const spent = await pool.query<{ kind: string; spent: boolean; entry: string | null }>(
          `SELECT kind, spent_at IS NOT NULL AS spent, spent_entry_id AS entry FROM reward ORDER BY kind`,
        );
        // In the enum's order: like, then fish.
        expect(spent.rows).toEqual([
          { kind: "like", spent: true, entry: null },
          { kind: "fish", spent: false, entry: null },
        ]);

        // A counted invitation's notice points at its invitation, and only it does.
        const notice = (kind: string, invitationId: string | null) =>
          pool.query("INSERT INTO notice (account_id, kind, invitation_id) VALUES ($1, $2, $3)", [
            inviter,
            kind,
            invitationId,
          ]);
        await expect(notice("invitation_counted", null)).rejects.toMatchObject(
          refused("notice_invitation_check"),
        );
        await expect(notice("warning", usedId)).rejects.toMatchObject({ code: "23514" });
        await notice("invitation_counted", usedId);

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

  /**
   * A copy of the migrations folder whose journal ends just before `tag`, so a
   * database can be brought to the state a deployed one had before it.
   */
  function migrationsBefore(tag: string): string {
    const journal = readJournal(MIGRATIONS) ?? [];
    const end = journal.findIndex((entry) => entry.tag === tag);
    expect(end, tag).toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), "kuutti-db-"));
    mkdirSync(join(dir, "meta"));
    const entries = journal.slice(0, end);
    for (const entry of entries) {
      copyFileSync(resolve(MIGRATIONS, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
    }
    writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ version: "7", entries }));
    return dir;
  }

  it("migration 0047 adds the reason to matching_config, nullable, and keeps every row as it was (#305)", async () => {
    const before0047 = migrationsBefore("0047_config_reason");
    // 0047 alone: a later migration's rows are not this one's to keep.
    const through0047 = migrationsBefore("0048_moderation_response_hours");
    try {
      await withTemporaryDatabase(async (url) => {
        const pool = createPool({ connectionString: url, max: 2 });
        try {
          await migrate(pool, before0047);
          const reasonColumn = () =>
            pool.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
              `SELECT data_type, is_nullable, column_default FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'matching_config' AND column_name = 'reason'`,
            );
          expect((await reasonColumn()).rows).toEqual([]);
          const columns = "id, key, version, value, valid_from, created_by";
          const order = "ORDER BY key, version";
          const rows = (
            await pool.query<Record<string, unknown>>(
              `SELECT ${columns} FROM matching_config ${order}`,
            )
          ).rows;
          // Versions 1 and 2 of the migrations before it, every one of them;
          // the keys a later migration adds (0072, #378; 0048, #303; 0052, #84; 0054, #348; 0057, #350; 0061, #351; 0065, #105; 0068, #376; 0075, #86; 0078, #385; 0080, #107; 0082 and 0083, #102) are not there yet.
          const later = new Set([
            "moderation_response_hours",
            "reports_per_day",
            "message_max_length",
            "messages_per_minute",
            "message_photos_per_day",
            "message_photo_attempts_per_day",
            "report_after_close_days",
            "auto_shadow_ban_reports",
            "auto_shadow_ban_reports_days",
            "auto_shadow_ban_first_messages",
            "auto_shadow_ban_first_messages_minutes",
            "auto_shadow_ban_same_first_message",
            "auto_shadow_ban_same_first_message_hours",
            "auto_shadow_ban_review_hours",
            "auto_shadow_ban_photo_fetches",
            "auto_shadow_ban_photo_fetches_minutes",
            "auto_shadow_ban_cards_served",
            "auto_shadow_ban_cards_served_minutes",
            "auto_shadow_ban_round_reads",
            "auto_shadow_ban_round_reads_minutes",
            "photo_queue_reject_days",
            "fish_budget",
            "fish_window_days",
            "email_code_minutes",
            "email_code_attempts",
            "email_codes_per_day",
            "invitation_reward",
            "invitations_open",
            "invitation_tries_per_day",
            "message_push_min_interval_minutes",
            "push_quiet_from_hour",
            "push_quiet_to_hour",
            "round_push_hour",
            "round_push_idle_days",
          ]);
          // A key's second version a later migration writes (0069, #95; 0070, #98) is not there yet either.
          const laterVersions = new Set(["round_size", "like_budget_balanced"]);
          expect(rows).toHaveLength(
            Object.keys(MATCHING_CONFIG_V1).filter((key) => !later.has(key)).length +
              Object.keys(MATCHING_CONFIG_V2).filter((key) => !laterVersions.has(key)).length,
          );

          expect(await migrate(pool, through0047)).toEqual({ state: "applied", applied: 1 });
          expect((await reasonColumn()).rows).toEqual([
            { data_type: "text", is_nullable: "YES", column_default: null },
          ]);
          const after = await pool.query<{
            key: string;
            version: number;
            value: unknown;
            valid_from: Date;
            created_by: string;
            reason: string | null;
          }>(`SELECT ${columns}, reason FROM matching_config ${order}`);
          expect(after.rows).toEqual(rows.map((row) => ({ ...row, reason: null })));
          // Each row reads in the panel as a version without a reason (#304).
          for (const row of after.rows) {
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
            `INSERT INTO matching_config (version, key, value, valid_from, created_by)
             VALUES (3, 'default_pond', '"suomi"'::jsonb, '2026-10-16T09:00:00Z', 'seed')`,
          );
          await pool.query(
            `INSERT INTO matching_config (version, key, value, valid_from, created_by, reason)
             VALUES (2, 'gate_k', '25'::jsonb, '2026-10-16T09:00:00Z', 'admin', 'Smaller ponds first')`,
          );
          const written = await pool.query<{ key: string; reason: string | null }>(
            `SELECT key, reason FROM matching_config
             WHERE (key, version) IN (('default_pond', 3), ('gate_k', 2)) ORDER BY key`,
          );
          expect(written.rows).toEqual([
            { key: "default_pond", reason: null },
            { key: "gate_k", reason: "Smaller ponds first" },
          ]);
        } finally {
          await pool.end();
        }
      });
    } finally {
      rmSync(before0047, { recursive: true, force: true });
      rmSync(through0047, { recursive: true, force: true });
    }
  });

  it("migrations 0086 and 0087 end every phone's session with its push token, leave the staff's, and give each session a family hash it must have (#490, ADR-059)", async () => {
    const before0086 = migrationsBefore("0086_end_sessions_for_token_family");
    try {
      await withTemporaryDatabase(async (url) => {
        const pool = createPool({ connectionString: url, max: 2 });
        try {
          await migrate(pool, before0086);
          const identity = await pool.query<{ id: string }>(
            "INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id",
            ["e".repeat(64)],
          );
          const identityId = identity.rows[0]?.id;
          const account = await pool.query<{ id: string }>(
            "INSERT INTO account (identity_id) VALUES ($1) RETURNING id",
            [identityId],
          );
          const accountId = account.rows[0]?.id;
          // A live session that has refreshed once, and one signed out, as rows before ADR-059 were.
          const sessions = await pool.query<{ id: string }>(
            `INSERT INTO session (account_id, platform, access_hash, access_expires_at, refresh_hash, retired_refresh_hash, expires_at, revoked_at)
             VALUES ($1, 'ios', 'a1', now() + interval '15 minutes', 'r1', 'r0', now() + interval '90 days', NULL),
                    ($1, 'android', 'a2', now() + interval '15 minutes', 'r2', NULL, now() + interval '90 days', now())
             RETURNING id`,
            [accountId],
          );
          await pool.query(
            `INSERT INTO push_token (account_id, session_id, token, platform, locale)
             VALUES ($1, $2, 'ExponentPushToken[migration-0086]', 'ios', 'fi')`,
            [accountId, sessions.rows[0]?.id],
          );
          await pool.query(
            `INSERT INTO admin_session (identity_id, role, access_hash, expires_at)
             VALUES ($1, 'moderator', 'staff-a1', now() + interval '8 hours')`,
            [identityId],
          );

          expect((await migrate(pool, MIGRATIONS)).state).toBe("applied");
          const count = async (table: string) =>
            Number(
              (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n,
            );
          expect(await count("session")).toBe(0);
          expect(await count("push_token")).toBe(0);
          expect(await count("admin_session")).toBe(1);
          expect(await count("account")).toBe(1);
          const columns = await pool.query<{ column_name: string; is_nullable: string }>(
            `SELECT column_name, is_nullable FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'session'
               AND column_name IN ('family_hash', 'refresh_hash', 'retired_refresh_hash')
             ORDER BY column_name`,
          );
          expect(columns.rows).toEqual([
            { column_name: "family_hash", is_nullable: "NO" },
            { column_name: "refresh_hash", is_nullable: "NO" },
          ]);
          const indexes = await pool.query<{ indexname: string }>(
            "SELECT indexname FROM pg_indexes WHERE tablename = 'session' ORDER BY indexname",
          );
          expect(indexes.rows.map((row) => row.indexname)).toEqual([
            "session_access_hash_unique",
            "session_account_idx",
            "session_family_hash_unique",
            "session_pkey",
            "session_refresh_hash_unique",
          ]);

          const insert = (family: string | null, refresh: string) =>
            pool.query(
              `INSERT INTO session (account_id, platform, access_hash, access_expires_at, refresh_hash, family_hash, expires_at)
               VALUES ($1, 'ios', $2, now() + interval '15 minutes', $2, $3, now() + interval '90 days')`,
              [accountId, refresh, family],
            );
          await insert("f1", "r3");
          await expect(insert(null, "r4")).rejects.toMatchObject({ code: "23502" });
          await expect(insert("f1", "r5")).rejects.toMatchObject({
            code: "23505",
            constraint: "session_family_hash_unique",
          });
        } finally {
          await pool.end();
        }
      });
    } finally {
      rmSync(before0086, { recursive: true, force: true });
    }
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
          "gate",
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
          "waitlist_snapshot",
        ]);
      } finally {
        await pool.end();
      }
    });
  });
});
