import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate } from "./migrate.ts";
import { createPool } from "./pool.ts";
import { MATCHING_CONFIG_V1, SEED_PONDS, seed } from "./seed.ts";
import { withTemporaryDatabase } from "./test/temporary-database.ts";

const MIGRATIONS = resolve(import.meta.dirname, "..", "drizzle");

describe("seed", () => {
  it("is idempotent and writes the pond tree and matching_config version 1", async () => {
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
        // One country-wide pond for now (#146); the tree is ready for the postal-code ponds later.
        expect(tree.rows).toEqual([{ slug: "suomi", parent: null, inessive: "Suomessa" }]);

        const config = await pool.query<{ key: string; value: number; version: number }>(
          "SELECT key, value, version FROM matching_config ORDER BY key",
        );
        expect(config.rows.every((r) => r.version === 1)).toBe(true);
        const byKey = Object.fromEntries(config.rows.map((r) => [r.key, r.value]));
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
          exposure_cards_per_day: 60,
          photo_fetches_per_day: { thumb: 600, card: 300, full: 60 },
          waitlist_k: 10,
          default_pond: "suomi",
          change_cadence_days: 30,
          deal_breakers_max: 2,
        });
        expect(byKey).toEqual(MATCHING_CONFIG_V1);
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
