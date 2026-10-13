-- Custom SQL migration file, put your code below! ---- matching_config version 1 row for the data export of #237 (ADR-007 §3,
-- apps/api/src/identity/export.ts): copies of one's own data a person may
-- take per Finnish calendar day, counted from account_export in the
-- statement that writes the row. The zip carries every full-size photo, so
-- the day's copies bound the exposure. The maintainer's number of
-- 13/10/2026: three. The seed carries the same row
-- (packages/db/src/seed.ts; migrate.test.ts keeps the two identical).
-- A new number is a new version, never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'exports_per_day', '3'::jsonb, 'migration:0040')
ON CONFLICT ("key", "version") DO NOTHING;
