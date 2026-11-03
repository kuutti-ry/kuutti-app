import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigKeyName, ConfigVersion } from "@kuutti/schema";
import { describe, expect, it } from "vitest";
import { readJournal } from "./journal.ts";
import { migrate } from "./migrate.ts";
import { migrationsStatus } from "./migrations.ts";
import { createPool, type Queryable } from "./pool.ts";
import { MATCHING_CONFIG_V1, MATCHING_CONFIG_V2, MATCHING_CONFIG_V3 } from "./seed.ts";
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

  it("carries matching_config versions 1, 2 and 3, the same rows as the seed", async () => {
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
        expect(at(3)).toEqual(MATCHING_CONFIG_V3);
        expect(at(4)).toEqual({});
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
          // the keys a later migration adds (0072, #378; 0048, #303; 0052, #84; 0054, #348; 0057, #350; 0061, #351; 0065, #105; 0068, #376; 0075, #86; 0078, #385; 0080, #107; 0082, #102; 0097, #514; 0104, #502) are not there yet.
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
            "home_min_inhabitants",
            "home_town_min_inhabitants",
            "distance_nearby_km",
            "distance_close_km",
            "distance_around_km",
            "liked_cooldown_days",
            "ended_cooldown_days",
            "second_pass_cooldown_days",
            "your_turn_limit",
            "your_turn_warning",
            "inbox_stop",
          ]);
          // A key's second version a later migration writes (0070, #98; 0088, #513; 0092, #508; 0104, #502) is not there yet either.
          const laterVersions = new Set([
            "like_budget_balanced",
            "auto_shadow_ban_photo_fetches",
            "deal_breakers_max",
            "pass_cooldown_days",
            "exposure_cards_per_day",
            "photo_fetches_per_day",
            "auto_shadow_ban_cards_served",
            "auto_shadow_ban_cards_served_minutes",
          ]);
          // The gate's two keys and default_pond's two versions stand here still, and so do the
          // daily set's keys: the seed has none of them, and 0094, 0101 and 0104 delete them (#500, #502).
          const goneSince = [
            "gate_k",
            "majority_share_max",
            "default_pond",
            "default_pond",
            "round_size",
            "impression_cap_per_day",
            "liked_you_cap",
            "shown_cooldown_days",
          ];
          expect(rows).toHaveLength(
            Object.keys(MATCHING_CONFIG_V1).filter((key) => !later.has(key)).length +
              Object.keys(MATCHING_CONFIG_V2).filter((key) => !laterVersions.has(key)).length +
              goneSince.length,
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
             VALUES (2, 'round_size', '25'::jsonb, '2026-10-16T09:00:00Z', 'admin', 'Smaller ponds first')`,
          );
          const written = await pool.query<{ key: string; reason: string | null }>(
            `SELECT key, reason FROM matching_config
             WHERE (key, version) IN (('default_pond', 3), ('round_size', 2)) ORDER BY key`,
          );
          expect(written.rows).toEqual([
            { key: "default_pond", reason: null },
            { key: "round_size", reason: "Smaller ponds first" },
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

  it("migrations 0093 and 0094 leave every pond closed, drop the gate and the date of whom one seeks, and delete the gate's two keys and no other (#500, ADR-060)", async () => {
    const before0093 = migrationsBefore("0093_pond_matching_switch");
    const through0094 = migrationsBefore("0095_one_pond");
    try {
      await withTemporaryDatabase(async (url) => {
        const pool = createPool({ connectionString: url, max: 2 });
        try {
          await migrate(pool, before0093);
          await pool.query(
            `INSERT INTO ponds (slug, name_nominative, name_inessive)
             VALUES ('paakaupunkiseutu', 'Pääkaupunkiseutu', 'Pääkaupunkiseudulla')`,
          );
          const identity = await pool.query<{ id: string }>(
            "INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id",
            ["0".repeat(64)],
          );
          // A person of the old gate, and a change of the key from the panel: both go.
          const account = await pool.query<{ id: string; pond_id: string }>(
            `INSERT INTO account (identity_id, pond_id, seeks_changed_at, gender_changed_at)
             SELECT $1, id, now(), '2026-10-01T09:00:00Z' FROM ponds WHERE slug = 'suomi'
             RETURNING id, pond_id`,
            [identity.rows[0]?.id],
          );
          await pool.query(
            "INSERT INTO gate (account_id, pond_id, opened_at, admitted_at) VALUES ($1, $2, now(), now())",
            [account.rows[0]?.id, account.rows[0]?.pond_id],
          );
          await pool.query(
            `INSERT INTO matching_config (version, key, value, created_by, reason)
             VALUES (2, 'gate_k', '25'::jsonb, 'admin', 'Smaller ponds first')`,
          );
          const keys = async () =>
            (
              await pool.query<{ key: string; versions: number }>(
                "SELECT key, count(*)::int AS versions FROM matching_config GROUP BY key ORDER BY key",
              )
            ).rows;
          const before = await keys();
          expect(before.map((row) => row.key)).toEqual(
            expect.arrayContaining(["change_cadence_days", "gate_k", "majority_share_max"]),
          );

          expect((await migrate(pool, through0094)).state).toBe("applied");

          expect(await keys()).toEqual(
            before.filter((row) => row.key !== "gate_k" && row.key !== "majority_share_max"),
          );
          const ponds = await pool.query("SELECT matching_open FROM ponds");
          expect(ponds.rows).toEqual([{ matching_open: false }, { matching_open: false }]);
          const table = await pool.query("SELECT to_regclass('public.gate') AS gate");
          expect(table.rows).toEqual([{ gate: null }]);
          const left = await pool.query("SELECT * FROM account");
          expect(left.rows[0]).not.toHaveProperty("seeks_changed_at");
          expect(left.rows[0]?.gender_changed_at).toEqual(new Date("2026-10-01T09:00:00Z"));
        } finally {
          await pool.end();
        }
      });
    } finally {
      rmSync(before0093, { recursive: true, force: true });
      rmSync(through0094, { recursive: true, force: true });
    }
  });

  it("migrations 0098 and 0099 rename the counter's table and key, every row and version as it stood (#500)", async () => {
    const before0098 = migrationsBefore("0098_pond_counter");
    try {
      await withTemporaryDatabase(async (url) => {
        const pool = createPool({ connectionString: url, max: 2 });
        try {
          await migrate(pool, before0098);
          // A pond's standing figures and a k an admin has raised: neither may be lost.
          await pool.query(
            `INSERT INTO waitlist_snapshot
               (pond_id, day, verified, woman, man, non_binary, finishing, seeks_men, seeks_everyone, seeks_women)
             SELECT id, '2026-10-30', 40, 12, 14, 11, 3, 10, 11, 12 FROM ponds WHERE slug = 'suomi'`,
          );
          await pool.query(
            `INSERT INTO matching_config (version, key, value, created_by, reason)
             VALUES (2, 'waitlist_k', '25'::jsonb, 'admin', 'A step of twenty-five')`,
          );
          const versions = async (key: string) =>
            (
              await pool.query(
                `SELECT version, value, valid_from, created_by, reason
                 FROM matching_config WHERE key = $1 ORDER BY version`,
                [key],
              )
            ).rows;
          const figures = (await pool.query("SELECT * FROM waitlist_snapshot")).rows;
          const kept = await versions("waitlist_k");
          expect(figures).toHaveLength(1);
          expect(kept).toHaveLength(2);

          expect((await migrate(pool, MIGRATIONS)).state).toBe("applied");

          const old = await pool.query("SELECT to_regclass('public.waitlist_snapshot') AS old");
          expect(old.rows).toEqual([{ old: null }]);
          expect((await pool.query("SELECT * FROM pond_counter")).rows).toEqual(figures);
          expect(await versions("pond_counter_k")).toEqual(kept);
          expect(await versions("waitlist_k")).toEqual([]);
          const constraints = await pool.query(
            `SELECT conname FROM pg_constraint
             WHERE conrelid = 'pond_counter'::regclass ORDER BY conname`,
          );
          expect(constraints.rows).toEqual([
            { conname: "pond_counter_pkey" },
            { conname: "pond_counter_pond_id_ponds_id_fk" },
          ]);
        } finally {
          await pool.end();
        }
      });
    } finally {
      rmSync(before0098, { recursive: true, force: true });
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

  /** A pond of the seed's or a panel's making: no migration writes one but `suomi`. */
  async function aPond(pool: Queryable, slug: string, parentId: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO ponds (slug, name_nominative, name_inessive, parent_id)
       VALUES ($1, $1, $1, $2) RETURNING id`,
      [slug, parentId],
    );
    return rows[0]?.id as string;
  }

  /** An account in a pond, or in none, in the given state. */
  async function aPerson(
    pool: Queryable,
    hash: string,
    pondId: string | null,
    state = "active",
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `WITH i AS (INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id)
       INSERT INTO account (identity_id, pond_id, state) SELECT id, $2::uuid, $3::account_state FROM i RETURNING id`,
      [hash.repeat(64), pondId, state],
    );
    return rows[0]?.id as string;
  }

  async function figures(pool: Queryable, pondId: string): Promise<void> {
    await pool.query(
      `INSERT INTO waitlist_snapshot (pond_id, day, verified, woman, man, non_binary, finishing)
       VALUES ($1, '2026-10-30', 40, 20, 19, 1, 12)`,
      [pondId],
    );
  }

  const suomiId = async (pool: Queryable) =>
    (await pool.query<{ id: string }>("SELECT id FROM ponds WHERE slug = 'suomi'")).rows[0]
      ?.id as string;
  const pondsOf = async (pool: Queryable) =>
    (await pool.query<{ slug: string }>("SELECT slug FROM ponds ORDER BY slug")).rows;
  const figuresLeft = async (pool: Queryable) =>
    Number(
      (await pool.query<{ n: string }>("SELECT count(*) AS n FROM waitlist_snapshot")).rows[0]?.n,
    );
  const versionsOf = async (pool: Queryable, key: string) =>
    (
      await pool.query<Record<string, unknown>>(
        "SELECT version, value, created_by, reason FROM matching_config WHERE key = $1 ORDER BY version",
        [key],
      )
    ).rows;

  it("migration 0095 moves everybody to suomi as they stand, opens it where any pond was open, and takes the capital, the ponds under it and every figure (#514, ADR-061 §8)", async () => {
    const before = migrationsBefore("0095_one_pond");
    const through = migrationsBefore("0096_account_home");
    try {
      await withTemporaryDatabase(async (url) => {
        const pool = createPool({ connectionString: url, max: 2 });
        try {
          await migrate(pool, before);
          const suomi = await suomiId(pool);
          // The seed's capital with two levels under it: ADR-010 §11's Espoo and Otaniemi.
          const capital = await aPond(pool, "paakaupunkiseutu", null);
          const espoo = await aPond(pool, "espoo", capital);
          const otaniemi = await aPond(pool, "otaniemi", espoo);
          await pool.query("UPDATE ponds SET matching_open = true WHERE id = $1", [capital]);
          const people = {
            capital: await aPerson(pool, "a", capital),
            espoo: await aPerson(pool, "b", espoo),
            otaniemi: await aPerson(pool, "c", otaniemi),
            suomi: await aPerson(pool, "d", suomi),
            none: await aPerson(pool, "e", null, "registered"),
            tombstone: await aPerson(pool, "f", null, "deleted"),
          };
          await figures(pool, capital);
          await figures(pool, suomi);

          expect(await migrate(pool, through)).toEqual({ state: "applied", applied: 1 });

          expect(await pondsOf(pool)).toEqual([{ slug: "suomi" }]);
          expect(await suomiId(pool)).toBe(suomi);
          const pondOf = async (id: string) =>
            (await pool.query("SELECT pond_id, state FROM account WHERE id = $1", [id])).rows[0];
          expect(await pondOf(people.capital)).toEqual({ pond_id: suomi, state: "active" });
          expect(await pondOf(people.espoo)).toEqual({ pond_id: suomi, state: "active" });
          expect(await pondOf(people.otaniemi)).toEqual({ pond_id: suomi, state: "active" });
          expect(await pondOf(people.suomi)).toEqual({ pond_id: suomi, state: "active" });
          expect(await pondOf(people.none)).toEqual({ pond_id: null, state: "registered" });
          expect(await pondOf(people.tombstone)).toEqual({ pond_id: null, state: "deleted" });
          // Nobody who had matching loses it: the capital was open, so the country is.
          const open = await pool.query("SELECT matching_open FROM ponds");
          expect(open.rows).toEqual([{ matching_open: true }]);
          // The boot counts afresh on an empty table.
          expect(await figuresLeft(pool)).toBe(0);
          expect(await versionsOf(pool, "default_pond")).toEqual([
            { version: 1, value: "suomi", created_by: "migration:0020", reason: null },
            { version: 2, value: "paakaupunkiseutu", created_by: "migration:0025", reason: null },
            { version: 3, value: "suomi", created_by: "migration:0095", reason: null },
          ]);
        } finally {
          await pool.end();
        }
      });
    } finally {
      rmSync(before, { recursive: true, force: true });
      rmSync(through, { recursive: true, force: true });
    }
  });

  it("migration 0095 needs no capital: a database with only suomi, as production is, keeps its people, stays closed, and loses its figures all the same (#514)", async () => {
    const before = migrationsBefore("0095_one_pond");
    const through = migrationsBefore("0096_account_home");
    try {
      await withTemporaryDatabase(async (url) => {
        const pool = createPool({ connectionString: url, max: 2 });
        try {
          await migrate(pool, before);
          expect(await pondsOf(pool)).toEqual([{ slug: "suomi" }]);
          const suomi = await suomiId(pool);
          await aPerson(pool, "a", suomi);
          await aPerson(pool, "b", null, "registered");
          await figures(pool, suomi);

          expect(await migrate(pool, through)).toEqual({ state: "applied", applied: 1 });

          expect(await pondsOf(pool)).toEqual([{ slug: "suomi" }]);
          const accounts = await pool.query<{ pond_id: string | null }>(
            "SELECT pond_id FROM account ORDER BY pond_id",
          );
          expect(accounts.rows).toEqual([{ pond_id: suomi }, { pond_id: null }]);
          // Nothing was open, so nothing opens: that is an admin's (ADR-060 §1).
          const open = await pool.query("SELECT matching_open FROM ponds");
          expect(open.rows).toEqual([{ matching_open: false }]);
          expect(await figuresLeft(pool)).toBe(0);
          // Version 2 dangled here, naming a pond this database never had; version 3 mends it.
          expect((await versionsOf(pool, "default_pond")).at(-1)).toEqual({
            version: 3,
            value: "suomi",
            created_by: "migration:0095",
            reason: null,
          });
        } finally {
          await pool.end();
        }
      });
    } finally {
      rmSync(before, { recursive: true, force: true });
      rmSync(through, { recursive: true, force: true });
    }
  });

  it("migrations 0095 and 0097 follow a value set in the panel with the next version, and leave its row and reason alone (#514, #305)", async () => {
    const before = migrationsBefore("0095_one_pond");
    const through = migrationsBefore("0101_default_pond_goes");
    try {
      await withTemporaryDatabase(async (url) => {
        const pool = createPool({ connectionString: url, max: 2 });
        try {
          await migrate(pool, before);
          await pool.query(
            `INSERT INTO matching_config (version, key, value, created_by, reason) VALUES
               (3, 'default_pond', '"paakaupunkiseutu"'::jsonb, 'admin', 'Start with the capital'),
               (3, 'deal_breakers_max', '4'::jsonb, 'admin', 'Fewer at first'),
               (4, 'deal_breakers_max', '5'::jsonb, 'admin', 'A few more')`,
          );

          expect((await migrate(pool, through)).state).toBe("applied");

          expect((await versionsOf(pool, "default_pond")).slice(-2)).toEqual([
            {
              version: 3,
              value: "paakaupunkiseutu",
              created_by: "admin",
              reason: "Start with the capital",
            },
            { version: 4, value: "suomi", created_by: "migration:0095", reason: null },
          ]);
          expect((await versionsOf(pool, "deal_breakers_max")).slice(-3)).toEqual([
            { version: 3, value: 4, created_by: "admin", reason: "Fewer at first" },
            { version: 4, value: 5, created_by: "admin", reason: "A few more" },
            { version: 5, value: 7, created_by: "migration:0097", reason: null },
          ]);
        } finally {
          await pool.end();
        }
      });
    } finally {
      rmSync(before, { recursive: true, force: true });
      rmSync(through, { recursive: true, force: true });
    }
  });

  it("migration 0100 takes the tree and the case form off the pond, and keeps its row, its switch and its people (#500)", async () => {
    const before = migrationsBefore("0100_pond_one_row");
    try {
      await withTemporaryDatabase(async (url) => {
        const pool = createPool({ connectionString: url, max: 2 });
        try {
          await migrate(pool, before);
          const suomi = await suomiId(pool);
          await pool.query("UPDATE ponds SET matching_open = true WHERE id = $1", [suomi]);
          await aPerson(pool, "a", suomi);

          expect((await migrate(pool, MIGRATIONS)).state).toBe("applied");

          const columns = await pool.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
             WHERE table_name = 'ponds' ORDER BY column_name`,
          );
          expect(columns.rows.map((row) => row.column_name)).toEqual([
            "created_at",
            "id",
            "matching_open",
            "name_nominative",
            "slug",
          ]);
          const ponds = await pool.query(
            "SELECT id, slug, name_nominative, matching_open FROM ponds",
          );
          expect(ponds.rows).toEqual([
            { id: suomi, slug: "suomi", name_nominative: "Suomi", matching_open: true },
          ]);
          const accounts = await pool.query("SELECT pond_id FROM account");
          expect(accounts.rows).toEqual([{ pond_id: suomi }]);
        } finally {
          await pool.end();
        }
      });
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  it("migration 0101 takes default_pond away, every version whoever wrote it, and no other key (#500)", async () => {
    const before = migrationsBefore("0101_default_pond_goes");
    // 0101 alone: the keys 0102 and 0104 take are theirs.
    const through = migrationsBefore("0102_round_push_goes");
    try {
      await withTemporaryDatabase(async (url) => {
        const pool = createPool({ connectionString: url, max: 2 });
        try {
          await migrate(pool, before);
          await pool.query(
            `INSERT INTO matching_config (version, key, value, created_by, reason)
             VALUES (4, 'default_pond', '"nowhere"'::jsonb, 'admin', 'A slug no row has')`,
          );
          const others = async () =>
            (
              await pool.query(
                "SELECT key, version, value FROM matching_config WHERE key <> 'default_pond' ORDER BY key, version",
              )
            ).rows;
          const kept = await others();
          expect((await versionsOf(pool, "default_pond")).length).toBe(4);

          expect((await migrate(pool, through)).state).toBe("applied");

          expect(await versionsOf(pool, "default_pond")).toEqual([]);
          expect(await others()).toEqual(kept);
        } finally {
          await pool.end();
        }
      });
    } finally {
      rmSync(before, { recursive: true, force: true });
      rmSync(through, { recursive: true, force: true });
    }
  });

  it("migration 0096 adds a home to nobody and a band to no entry, and takes only the bands there are (#514, ADR-061 §5)", async () => {
    const before = migrationsBefore("0096_account_home");
    try {
      await withTemporaryDatabase(async (url) => {
        const pool = createPool({ connectionString: url, max: 2 });
        try {
          await migrate(pool, before);
          const [one, other] = [await aPerson(pool, "a", null), await aPerson(pool, "b", null)];
          const { rows: rounds } = await pool.query<{ id: string }>(
            "INSERT INTO rounds (account_id, day) VALUES ($1, '2026-10-30') RETURNING id",
            [one],
          );
          await pool.query(
            `INSERT INTO round_entries (round_id, position, candidate_id, reason)
             VALUES ($1, 1, $2, 'matches_filters')`,
            [rounds[0]?.id, other],
          );

          expect((await migrate(pool, MIGRATIONS)).state).toBe("applied");

          const homes = await pool.query(
            "SELECT DISTINCT home_place, home_shows_area FROM account",
          );
          expect(homes.rows).toEqual([{ home_place: null, home_shows_area: false }]);
          const write = (band: string) =>
            pool.query("UPDATE round_entries SET distance = $1 RETURNING distance", [band]);
          const entries = await pool.query("SELECT distance FROM round_entries");
          expect(entries.rows).toEqual([{ distance: null }]);
          for (const band of ["nearby", "close", "around", "far"]) {
            expect((await write(band)).rows).toEqual([{ distance: band }]);
          }
          await expect(write("12 km")).rejects.toMatchObject({ code: "22P02" });
        } finally {
          await pool.end();
        }
      });
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  describe("the queue's migrations (#502, ADR-062)", () => {
    /** Every key of the daily set and the round's push, which 0102 and 0104 delete whole. */
    const GONE = [
      "round_size",
      "liked_you_cap",
      "shown_cooldown_days",
      "impression_cap_per_day",
      "round_push_hour",
      "round_push_idle_days",
    ];

    it("migrations 0102 and 0104 take the daily set's keys and the round's push away, every version whoever wrote it, and no switch of the kind survives", async () => {
      const before = migrationsBefore("0102_round_push_goes");
      try {
        await withTemporaryDatabase(async (url) => {
          const pool = createPool({ connectionString: url, max: 2 });
          try {
            await migrate(pool, before);
            const person = await aPerson(pool, "a", null);
            await pool.query(
              `INSERT INTO notification_preference (account_id, kind, enabled) VALUES
                 ($1, 'round', false), ($1, 'message', false), ($1, 'match', true)`,
              [person],
            );
            await pool.query(
              `INSERT INTO matching_config (version, key, value, created_by, reason) VALUES
                 (3, 'round_size', '8'::jsonb, 'admin', 'Fewer at first'),
                 (2, 'round_push_hour', '10'::jsonb, 'admin', 'A little later')`,
            );
            const others = async () =>
              (
                await pool.query(
                  `SELECT key, version, value FROM matching_config
                    WHERE key <> ALL($1::text[]) AND created_by <> 'migration:0104'
                    ORDER BY key, version`,
                  [GONE],
                )
              ).rows;
            const kept = await others();
            for (const key of GONE) {
              expect((await versionsOf(pool, key)).length, key).toBeGreaterThan(0);
            }

            expect((await migrate(pool, MIGRATIONS)).state).toBe("applied");

            for (const key of GONE) expect(await versionsOf(pool, key), key).toEqual([]);
            expect(await others()).toEqual(kept);
            const switches = await pool.query(
              "SELECT kind, enabled FROM notification_preference ORDER BY kind",
            );
            expect(switches.rows).toEqual([
              { kind: "message", enabled: false },
              { kind: "match", enabled: true },
            ]);
            const kinds = await pool.query<{ label: string }>(
              "SELECT unnest(enum_range(NULL::notification_kind))::text AS label",
            );
            expect(kinds.rows.map((row) => row.label)).toEqual(["message", "match", "moderation"]);
            await expect(
              pool.query(
                "INSERT INTO notification_preference (account_id, kind, enabled) VALUES ($1, 'round', false)",
                [person],
              ),
            ).rejects.toThrow(/invalid input value for enum notification_kind/);
          } finally {
            await pool.end();
          }
        });
      } finally {
        rmSync(before, { recursive: true, force: true });
      }
    });

    it("migration 0103 adds the skip and the second pass's mark, which only a pass carries, and takes the move's time off the account", async () => {
      const before = migrationsBefore("0103_queue_ladder");
      try {
        await withTemporaryDatabase(async (url) => {
          const pool = createPool({ connectionString: url, max: 2 });
          try {
            await migrate(pool, before);
            const [one, other] = [await aPerson(pool, "a", null), await aPerson(pool, "b", null)];
            await pool.query("UPDATE account SET home_moved_at = now() WHERE id = $1", [one]);
            const { rows: rounds } = await pool.query<{ id: string }>(
              "INSERT INTO rounds (account_id, day) VALUES ($1, '2026-10-30') RETURNING id",
              [one],
            );
            await pool.query(
              `INSERT INTO round_entries (round_id, position, candidate_id, reason, decision, decided_at)
               VALUES ($1, 1, $2, 'matches_filters', 'pass', now())`,
              [rounds[0]?.id, other],
            );

            expect((await migrate(pool, MIGRATIONS)).state).toBe("applied");

            const moved = await pool.query(
              `SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'home_moved_at'`,
            );
            expect(moved.rows).toEqual([]);
            const mark = (value: boolean, decision: string) =>
              pool.query(
                "UPDATE round_entries SET decision = $2::round_decision, second_pass = $1 RETURNING second_pass",
                [value, decision],
              );
            // A pass from before it is a first pass.
            const entries = await pool.query("SELECT second_pass FROM round_entries");
            expect(entries.rows).toEqual([{ second_pass: false }]);
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
      } finally {
        rmSync(before, { recursive: true, force: true });
      }
    });

    it("migration 0104 follows a value set in the panel with the next version, the photo budget's other sizes as they were, and writes the new keys", async () => {
      const before = migrationsBefore("0104_queue_config");
      try {
        await withTemporaryDatabase(async (url) => {
          const pool = createPool({ connectionString: url, max: 2 });
          try {
            await migrate(pool, before);
            await pool.query(
              `INSERT INTO matching_config (version, key, value, created_by, reason) VALUES
                 (2, 'pass_cooldown_days', '60'::jsonb, 'admin', 'Two months'),
                 (2, 'exposure_cards_per_day', '45'::jsonb, 'admin', 'Fewer'),
                 (2, 'photo_fetches_per_day', '{"thumb": 500, "card": 200, "full": 30}'::jsonb, 'admin', 'Fewer'),
                 (3, 'photo_fetches_per_day', '{"thumb": 400, "card": 100, "full": 20}'::jsonb, 'admin', 'Fewer still'),
                 (2, 'auto_shadow_ban_cards_served', '45'::jsonb, 'admin', 'On'),
                 (2, 'auto_shadow_ban_cards_served_minutes', '30'::jsonb, 'admin', 'Shorter'),
                 (3, 'auto_shadow_ban_photo_fetches', '250'::jsonb, 'admin', 'Higher')`,
            );

            expect((await migrate(pool, MIGRATIONS)).state).toBe("applied");

            const next = (version: number, value: unknown) => ({
              version,
              value,
              created_by: "migration:0104",
              reason: null,
            });
            for (const [key, version, value] of [
              ["pass_cooldown_days", 3, 30],
              ["exposure_cards_per_day", 3, 0],
              ["photo_fetches_per_day", 4, { thumb: 400, card: 0, full: 20 }],
              ["auto_shadow_ban_cards_served", 3, 300],
              ["auto_shadow_ban_cards_served_minutes", 3, 10],
              ["auto_shadow_ban_photo_fetches", 4, 1500],
            ] as const) {
              const versions = await versionsOf(pool, key);
              expect(versions.at(-1), key).toEqual(next(version, value));
              // The panel's own row stays as it was, its reason with it.
              expect(versions.at(-2)?.created_by, key).toBe("admin");
            }
            for (const [key, value] of [
              ["liked_cooldown_days", 90],
              ["ended_cooldown_days", 90],
              ["second_pass_cooldown_days", 365],
              ["your_turn_limit", 8],
              ["your_turn_warning", 6],
              ["inbox_stop", 30],
            ] as const) {
              expect(await versionsOf(pool, key), key).toEqual([next(1, value)]);
            }
          } finally {
            await pool.end();
          }
        });
      } finally {
        rmSync(before, { recursive: true, force: true });
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
        ]);
      } finally {
        await pool.end();
      }
    });
  });
});
