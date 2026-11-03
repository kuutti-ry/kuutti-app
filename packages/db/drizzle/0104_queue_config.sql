-- Custom SQL migration file, put your code below! --
-- What the queue reads and no longer reads (#502, #503, ADR-062). The keys of
-- the daily set go whole, every version of each (rules/db.md): round_size and
-- liked_you_cap (§1), shown_cooldown_days, which the ladder's clocks replace
-- (§6), and impression_cap_per_day, which nothing ever read and the inbox stop
-- replaces (§4). The seed has dropped them too.
DELETE FROM "matching_config"
 WHERE "key" IN ('round_size', 'liked_you_cap', 'shown_cooldown_days', 'impression_cap_per_day');--> statement-breakpoint

-- matching_config version 1 rows for the ladder, the your-turn limit and the
-- inbox stop: #503's table of 29/10/2026 for the clocks and the limit, and the
-- maintainer's of 01/11/2026 for the second pass, the warning and the stop. The
-- seed carries the same rows (packages/db/src/seed.ts; migrate.test.ts keeps
-- the two identical). A new value is a new version, written by an admin in the
-- panel (#305), never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'liked_cooldown_days', '90'::jsonb, 'migration:0104'),
  (1, 'ended_cooldown_days', '90'::jsonb, 'migration:0104'),
  (1, 'second_pass_cooldown_days', '365'::jsonb, 'migration:0104'),
  (1, 'your_turn_limit', '8'::jsonb, 'migration:0104'),
  (1, 'your_turn_warning', '6'::jsonb, 'migration:0104'),
  (1, 'inbox_stop', '30'::jsonb, 'migration:0104')
ON CONFLICT ("key", "version") DO NOTHING;--> statement-breakpoint

-- New versions of five keys, each the next of its key, as 0088 writes one, so
-- that a value set in the panel before this ran is followed, not kept; on a
-- database with the seed's rows they are the rows the seed writes too. A
-- migration names itself in created_by and gives no reason; ADR-062 §6 and §9
-- say why: the pass's clock is thirty days, there is no ceiling on cards, and
-- the two alarms are what stands instead, the maintainer's of 01/11/2026.
INSERT INTO "matching_config" ("version", "key", "value", "created_by")
SELECT coalesce(max("version"), 0) + 1, 'pass_cooldown_days', '30'::jsonb, 'migration:0104'
  FROM "matching_config" WHERE "key" = 'pass_cooldown_days';--> statement-breakpoint
INSERT INTO "matching_config" ("version", "key", "value", "created_by")
SELECT coalesce(max("version"), 0) + 1, 'exposure_cards_per_day', '0'::jsonb, 'migration:0104'
  FROM "matching_config" WHERE "key" = 'exposure_cards_per_day';--> statement-breakpoint
INSERT INTO "matching_config" ("version", "key", "value", "created_by")
SELECT "version" + 1, 'photo_fetches_per_day', jsonb_set("value", '{card}', '0'::jsonb), 'migration:0104'
  FROM "matching_config" WHERE "key" = 'photo_fetches_per_day'
 ORDER BY "version" DESC LIMIT 1;--> statement-breakpoint
INSERT INTO "matching_config" ("version", "key", "value", "created_by")
SELECT coalesce(max("version"), 0) + 1, 'auto_shadow_ban_cards_served', '300'::jsonb, 'migration:0104'
  FROM "matching_config" WHERE "key" = 'auto_shadow_ban_cards_served';--> statement-breakpoint
INSERT INTO "matching_config" ("version", "key", "value", "created_by")
SELECT coalesce(max("version"), 0) + 1, 'auto_shadow_ban_cards_served_minutes', '10'::jsonb, 'migration:0104'
  FROM "matching_config" WHERE "key" = 'auto_shadow_ban_cards_served_minutes';--> statement-breakpoint
INSERT INTO "matching_config" ("version", "key", "value", "created_by")
SELECT coalesce(max("version"), 0) + 1, 'auto_shadow_ban_photo_fetches', '1500'::jsonb, 'migration:0104'
  FROM "matching_config" WHERE "key" = 'auto_shadow_ban_photo_fetches';
