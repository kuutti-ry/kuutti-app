-- Custom SQL migration file, put your code below! ---- matching_config version 1 rows for the closer look of #253 (ADR-006 §2,
-- apps/api/src/safety/photo-check.ts): `attempts` photos the check did not
-- show for a hard label within `window_days` make it stricter for that
-- account for `days` from the last of them, its reject line dropping to
-- `reject` for every hard group. The maintainer's numbers of 12/10/2026: two
-- in 30 days, 30 days, 75. The seed carries the same rows
-- (packages/db/src/seed.ts; migrate.test.ts keeps the two identical).
-- A new number is a new version, never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'photo_closer_look_attempts', '2'::jsonb, 'migration:0035'),
  (1, 'photo_closer_look_window_days', '30'::jsonb, 'migration:0035'),
  (1, 'photo_closer_look_days', '30'::jsonb, 'migration:0035'),
  (1, 'photo_closer_look_reject', '75'::jsonb, 'migration:0035')
ON CONFLICT ("key", "version") DO NOTHING;
