-- Custom SQL migration file, put your code below! --
-- matching_config version 1 rows for the home and the distance (#514, ADR-061
-- §2, §3 and §5), the maintainer's of 31/10/2026: a place kept has at least
-- home_min_inhabitants people, a town on a card at least
-- home_town_min_inhabitants, and the bands end at distance_nearby_km,
-- distance_close_km and distance_around_km; far has no edge. The seed carries
-- the same rows (packages/db/src/seed.ts; migrate.test.ts keeps the two
-- identical). A new value is a new version, written by an admin in the panel
-- (#305), never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'home_min_inhabitants', '3000'::jsonb, 'migration:0097'),
  (1, 'home_town_min_inhabitants', '20000'::jsonb, 'migration:0097'),
  (1, 'distance_nearby_km', '5'::jsonb, 'migration:0097'),
  (1, 'distance_close_km', '15'::jsonb, 'migration:0097'),
  (1, 'distance_around_km', '50'::jsonb, 'migration:0097')
ON CONFLICT ("key", "version") DO NOTHING;--> statement-breakpoint

-- A new version of deal_breakers_max (ADR-061 §7): seven, the six fields and
-- the distance, which is no field. Written as the next version of the key, as
-- 0092 writes it, so that a value set in the panel before this ran is followed,
-- not kept; on a database with two versions it is version 3, the row the seed
-- writes too. The migration names itself in created_by and gives no reason, as
-- every version a migration writes; this comment and ADR-061 say why.
INSERT INTO "matching_config" ("version", "key", "value", "created_by")
SELECT coalesce(max("version"), 0) + 1, 'deal_breakers_max', '7'::jsonb, 'migration:0097'
  FROM "matching_config" WHERE "key" = 'deal_breakers_max';
