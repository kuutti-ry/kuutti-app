-- Custom SQL migration file, put your code below! --
-- matching_config version 1 row for the round's push (#102, ADR-055 §6, the
-- maintainer's of 25/10/2026): nobody who opened no round in the last
-- round_push_idle_days Finnish days is told of today's, counting from the
-- first round of somebody who never opened one. The seed carries the same row
-- (packages/db/src/seed.ts; migrate.test.ts keeps the two identical). A new
-- value is a new version, written by an admin in the panel (#305), never an
-- edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'round_push_idle_days', '7'::jsonb, 'migration:0083')
ON CONFLICT ("key", "version") DO NOTHING;
