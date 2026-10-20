-- Custom SQL migration file, put your code below! --
-- matching_config version 1 rows for the fish of #378 (ADR-039 §3,
-- apps/api/src/matching/rounds.ts): how many fish a person may send in any
-- fish_window_days, rolling, the maintainer's one in seven of 20/10/2026. The
-- seed carries the same rows (packages/db/src/seed.ts; migrate.test.ts keeps
-- the two identical). A new number is a new version, written by an admin in
-- the panel (#305), never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'fish_budget', '1'::jsonb, 'migration:0072'),
  (1, 'fish_window_days', '7'::jsonb, 'migration:0072')
ON CONFLICT ("key", "version") DO NOTHING;
