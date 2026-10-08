-- Custom SQL migration file, put your code below! --
-- matching_config version 1 row for the cadence of a change of gender or of
-- whom one seeks (#147, the field sheet's gender model, ADR-015 §9): once in
-- this many days, effective from the next count. The seed carries the same
-- row (packages/db/src/seed.ts; migrate.test.ts keeps the two identical). A
-- new number is a new version, never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'change_cadence_days', '30'::jsonb, 'migration:0022')
ON CONFLICT ("key", "version") DO NOTHING;
