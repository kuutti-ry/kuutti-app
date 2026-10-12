-- Custom SQL migration file, put your code below! ---- matching_config version 1 rows for the two main-photo tips of #253
-- (apps/api/src/profile/tips.ts): a swimwear, underwear or partial-nudity
-- label, and a Fish or Fishing scene label, at or above these confidences on
-- the main photo. 80, so a tip is said only where the check is fairly sure;
-- neither ever holds a photo back. The seed carries the same rows
-- (packages/db/src/seed.ts; migrate.test.ts keeps the two identical).
-- A new number is a new version, never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'photo_tip_revealing_confidence_min', '80'::jsonb, 'migration:0031'),
  (1, 'photo_tip_fish_confidence_min', '80'::jsonb, 'migration:0031')
ON CONFLICT ("key", "version") DO NOTHING;
