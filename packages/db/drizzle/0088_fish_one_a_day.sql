-- Custom SQL migration file, put your code below! --
-- A new version of fish_window_days (#475, ADR-039 §3): one fish a day, the
-- maintainer's of 29/10/2026, where version 1 (migration 0072) took one in
-- seven. With the window one Finnish day long the next fish comes with the
-- next round, so the round offers Send a fish while one can go and says
-- nothing of when the next comes. Written as the next version of the key, as
-- 0069 writes round_size, so a value set in the panel before this ran (#305)
-- is followed, not kept; on a database with only version 1 it is version 2,
-- the row the seed writes too (packages/db/src/seed.ts; migrate.test.ts keeps
-- the two identical). The migration names itself in created_by and gives no
-- reason, as every version a migration writes; this comment and ADR-039 say why.
INSERT INTO "matching_config" ("version", "key", "value", "created_by")
SELECT coalesce(max("version"), 0) + 1, 'fish_window_days', '1'::jsonb, 'migration:0088'
  FROM "matching_config" WHERE "key" = 'fish_window_days';
