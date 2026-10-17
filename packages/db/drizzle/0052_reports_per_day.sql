-- Custom SQL migration file, put your code below! --
-- matching_config version 1 row for the reports of #84 (ADR-030 §4,
-- apps/api/src/safety/reports.ts): reports a person may file per Finnish
-- calendar day, counted from report in the statement that writes the row;
-- the next one is refused in words and writes nothing, the block included.
-- Five, as for feedback. The seed carries the same row
-- (packages/db/src/seed.ts; migrate.test.ts keeps the two identical). A new
-- number is a new version, written by an admin in the panel (#305), never an
-- edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'reports_per_day', '5'::jsonb, 'migration:0052')
ON CONFLICT ("key", "version") DO NOTHING;
