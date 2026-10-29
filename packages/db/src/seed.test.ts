import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate } from "./migrate.ts";
import { createPool } from "./pool.ts";
import { MATCHING_CONFIG_V1, MATCHING_CONFIG_V2, SEED_PONDS, seed } from "./seed.ts";
import { withTemporaryDatabase } from "./test/temporary-database.ts";

const MIGRATIONS = resolve(import.meta.dirname, "..", "drizzle");

describe("seed", () => {
  it("is idempotent and writes the pond tree and matching_config versions 1 and 2", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      try {
        await migrate(pool, MIGRATIONS);
        const first = await seed(pool);
        const second = await seed(pool);
        expect(second).toEqual(first);

        const pondCount = await pool.query<{ n: string }>("SELECT count(*) AS n FROM ponds");
        expect(Number(pondCount.rows[0]?.n)).toBe(SEED_PONDS.length);

        const tree = await pool.query<{ slug: string; parent: string | null; inessive: string }>(
          `SELECT c.slug, p.slug AS parent, c.name_inessive AS inessive
           FROM ponds c LEFT JOIN ponds p ON p.id = c.parent_id ORDER BY c.slug`,
        );
        // Two ponds side by side, the capital region and the rest of the country (#174, ADR-010 §12); the tree waits for the postal-code ponds.
        expect(tree.rows).toEqual([
          { slug: "paakaupunkiseutu", parent: null, inessive: "Pääkaupunkiseudulla" },
          { slug: "suomi", parent: null, inessive: "Suomessa" },
        ]);

        const config = await pool.query<{ key: string; value: number; version: number }>(
          "SELECT key, value, version FROM matching_config ORDER BY key, version",
        );
        const byKey = Object.fromEntries(
          config.rows.filter((r) => r.version === 1).map((r) => [r.key, r.value]),
        );
        // The decisions log numbers, read back from the database.
        expect(byKey).toEqual({
          gate_k: 30,
          majority_share_max: 0.6,
          round_size: 12,
          impression_cap_per_day: 40,
          like_budget_balanced: 12,
          like_budget_contested: 5,
          contest_ratio_threshold: 1.5,
          liked_you_cap: 10,
          like_expiry_days: 14,
          pass_cooldown_days: 90,
          shown_cooldown_days: 30,
          silent_match_archive_days: 7,
          max_photos: 6,
          photo_moderation_label_threshold: 60,
          photo_moderation_face_threshold: 90,
          photo_moderation_nudity_review: 60,
          photo_moderation_nudity_reject: 90,
          photo_moderation_violence_review: 60,
          photo_moderation_violence_reject: 90,
          photo_moderation_disturbing_review: 60,
          photo_moderation_disturbing_reject: 90,
          photo_moderation_hate_review: 60,
          photo_moderation_hate_reject: 90,
          photo_moderation_nudity_no_appeal: 95,
          photo_closer_look_attempts: 2,
          photo_closer_look_window_days: 30,
          photo_closer_look_days: 30,
          photo_closer_look_reject: 75,
          photo_queue_reject_days: 14,
          fish_budget: 1,
          fish_window_days: 7,
          photo_tip_mirror_confidence_min: 50,
          photo_tip_bathroom_confidence_min: 50,
          photo_tip_sunglasses_confidence_min: 50,
          photo_tip_tight_crop_face_area_min: 0.4,
          photo_tip_brightness_below: 40,
          photo_tip_sharpness_below: 20,
          photo_tip_group_photo_min_faces: 2,
          photo_tip_photos_suggested: 3,
          photo_tip_revealing_confidence_min: 80,
          photo_tip_fish_confidence_min: 80,
          photo_tip_fish_species_min: 70,
          photo_description_confidence_min: 80,
          exposure_cards_per_day: 60,
          photo_fetches_per_day: { thumb: 600, card: 300, full: 60 },
          exports_per_day: 3,
          feedback_per_day: 5,
          email_code_minutes: 30,
          email_code_attempts: 3,
          email_codes_per_day: 5,
          // #107: the invitations, the reward the maintainer's of 22/10/2026.
          invitation_reward: { fish: 1, likes: 0 },
          invitations_open: 5,
          invitation_tries_per_day: 5,
          // #102: the push, the maintainer's of 25/10/2026.
          message_push_min_interval_minutes: 10,
          push_quiet_from_hour: 22,
          push_quiet_to_hour: 8,
          round_push_hour: 9,
          round_push_idle_days: 7,
          moderation_response_hours: 24,
          reports_per_day: 5,
          report_after_close_days: 30,
          // #105: the automatic shadow bans, the maintainer's of 19/10/2026.
          auto_shadow_ban_reports: 3,
          auto_shadow_ban_reports_days: 7,
          auto_shadow_ban_first_messages: 20,
          auto_shadow_ban_first_messages_minutes: 60,
          auto_shadow_ban_same_first_message: 5,
          auto_shadow_ban_same_first_message_hours: 24,
          auto_shadow_ban_review_hours: 48,
          // #86: the velocity rules, the maintainer's of 21/10/2026.
          auto_shadow_ban_photo_fetches: 120,
          auto_shadow_ban_photo_fetches_minutes: 60,
          auto_shadow_ban_cards_served: 0,
          auto_shadow_ban_cards_served_minutes: 60,
          auto_shadow_ban_round_reads: 30,
          auto_shadow_ban_round_reads_minutes: 1,
          message_max_length: 2000,
          message_photo_attempts_per_day: 30,
          message_photos_per_day: 10,
          messages_per_minute: 30,
          waitlist_k: 10,
          default_pond: "suomi",
          change_cadence_days: 30,
          deal_breakers_max: 2,
        });
        expect(byKey).toEqual(MATCHING_CONFIG_V1);
        // Version 2 (ADR-010 §11): the one pond is the capital region, and it wins over version 1;
        // the round is ten cards (#95, ADR-035), and ten likes a day (#98, ADR-036).
        const later = Object.fromEntries(
          config.rows.filter((r) => r.version === 2).map((r) => [r.key, r.value]),
        );
        expect(later).toEqual({
          default_pond: "paakaupunkiseutu",
          round_size: 10,
          like_budget_balanced: 10,
          auto_shadow_ban_photo_fetches: 200,
        });
        expect(later).toEqual(MATCHING_CONFIG_V2);
      } finally {
        await pool.end();
      }
    });
  });

  it("writes no reason, and leaves the panel's later versions and their reasons as they were (#305)", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 2 });
      try {
        await migrate(pool, MIGRATIONS);
        await seed(pool);
        const withReason = async () =>
          (
            await pool.query<{ key: string; version: number; value: unknown; reason: string }>(
              "SELECT key, version, value, reason FROM matching_config WHERE reason IS NOT NULL ORDER BY key",
            )
          ).rows;
        // The seed's and the migrations' rows were written before reasons were kept.
        expect(await withReason()).toEqual([]);

        // Two changes from the panel, then a preview's next boot seeds again.
        await pool.query(
          `INSERT INTO matching_config (version, key, value, valid_from, created_by, reason) VALUES
             (3, 'default_pond', '"suomi"'::jsonb, '2026-10-16T09:00:00Z', 'admin', 'Open the country'),
             (2, 'gate_k', '25'::jsonb, '2026-10-16T09:00:00Z', 'admin', 'Smaller ponds first')`,
        );
        await seed(pool);
        expect(await withReason()).toEqual([
          { key: "default_pond", version: 3, value: "suomi", reason: "Open the country" },
          { key: "gate_k", version: 2, value: 25, reason: "Smaller ponds first" },
        ]);
        const latest = await pool.query<{ key: string; version: number }>(
          `SELECT key, max(version) AS version FROM matching_config
           WHERE key IN ('default_pond', 'gate_k') GROUP BY key ORDER BY key`,
        );
        expect(latest.rows).toEqual([
          { key: "default_pond", version: 3 },
          { key: "gate_k", version: 2 },
        ]);
      } finally {
        await pool.end();
      }
    });
  });

  it("refuses production before opening a connection", async () => {
    const result = await new Promise<{ code: number | null; err: string }>((done) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/cli/seed.ts", "--env", "production"],
        {
          cwd: resolve(import.meta.dirname, ".."),
          // A closed port: any connection attempt would fail with a different message.
          env: {
            PATH: process.env.PATH ?? "",
            DATABASE_URL: "postgres://kuutti:kuutti@127.0.0.1:1/nope",
          },
        },
      );
      let err = "";
      child.stderr.on("data", (c: Buffer) => {
        err += c.toString();
      });
      child.on("close", (code) => done({ code, err }));
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain("refusing to seed production");
    expect(result.err).not.toContain("ECONNREFUSED");
  });
});
