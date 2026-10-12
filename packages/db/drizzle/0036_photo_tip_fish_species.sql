-- Custom SQL migration file, put your code below! ---- matching_config version 1 row for the fish tip's species of #253
-- (apps/api/src/profile/tips.ts): a species label of Finland's and nearby
-- waters at or above this confidence on the main photo lets the fish tip name
-- the fish. 70: on the probe picture of a pike (12/10/2026) Pike came back at
-- 76.5 and every other species under 56. The seed carries the same row
-- (packages/db/src/seed.ts; migrate.test.ts keeps the two identical).
-- A new number is a new version, never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'photo_tip_fish_species_min', '70'::jsonb, 'migration:0036')
ON CONFLICT ("key", "version") DO NOTHING;
