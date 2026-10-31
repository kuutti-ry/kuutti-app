-- Custom SQL migration file, put your code below! --
-- A new version of deal_breakers_max (#508, ADR-009 §1 and History 2026-10-31):
-- six, the maintainer's of 31/10/2026, where version 1 (migration 0024) took
-- two. Height is the sixth field a deal-breaker can be set on, so a person may
-- now hold one on every field. Written as the next version of the key, as 0069
-- writes round_size, so a value set in the panel before this ran (#305) is
-- followed, not kept; on a database with only version 1 it is version 2, the
-- row the seed writes too (packages/db/src/seed.ts; migrate.test.ts keeps the
-- two identical). The migration names itself in created_by and gives no
-- reason, as every version a migration writes; this comment and ADR-009 say
-- why.
INSERT INTO "matching_config" ("version", "key", "value", "created_by")
SELECT coalesce(max("version"), 0) + 1, 'deal_breakers_max', '6'::jsonb, 'migration:0092'
  FROM "matching_config" WHERE "key" = 'deal_breakers_max';
