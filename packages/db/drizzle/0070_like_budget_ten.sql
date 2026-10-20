-- Custom SQL migration file, put your code below! --
-- A new version of like_budget_balanced (#98, ADR-036 §2): ten likes a day for
-- everybody in the first cut, the maintainer's of 20/10/2026, where version 1
-- (migration 0007) took TD-14's twelve for a balanced pond. Written as the
-- next version of the key, as 0069 writes round_size, so a value set in the
-- panel before this ran (#305) is followed, not kept; on a database with only
-- version 1 it is version 2, the row the seed writes too
-- (packages/db/src/seed.ts; migrate.test.ts keeps the two identical). The
-- migration names itself in created_by and gives no reason, as every version
-- a migration writes; this comment and ADR-036 say why.
INSERT INTO "matching_config" ("version", "key", "value", "created_by")
SELECT coalesce(max("version"), 0) + 1, 'like_budget_balanced', '10'::jsonb, 'migration:0070'
  FROM "matching_config" WHERE "key" = 'like_budget_balanced';
