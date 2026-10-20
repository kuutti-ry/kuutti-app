-- Custom SQL migration file, put your code below! --
-- A new version of round_size (#95, ADR-035 §3): the first cut's round holds
-- at most ten cards, the maintainer's of 20/10/2026, where version 1
-- (migration 0007) took TD-11's twelve. Written as the next version of the
-- key, so a value set in the panel before this ran (#305) is followed, not
-- kept; on a database with only version 1 it is version 2, the row the seed
-- writes too (packages/db/src/seed.ts; migrate.test.ts keeps the two
-- identical). Earlier versions keep their rows, the latest wins
-- (apps/api/src/lib/matching-config.ts). A later value is a new version from
-- the panel with its reason, never an edit of this file.
-- The migration names itself in created_by and gives no reason, as every
-- version a migration writes (the reason is the panel's, #305); this comment
-- and ADR-035 say why.
INSERT INTO "matching_config" ("version", "key", "value", "created_by")
SELECT coalesce(max("version"), 0) + 1, 'round_size', '10'::jsonb, 'migration:0069'
  FROM "matching_config" WHERE "key" = 'round_size';
