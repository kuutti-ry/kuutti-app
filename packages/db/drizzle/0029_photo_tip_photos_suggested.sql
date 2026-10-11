-- Custom SQL migration file, put your code below! ---- matching_config version 1 row for the photo-count tip of #56: a complete
-- profile with fewer photos than this, approved or in review, hears that more
-- would help. It was a constant in packages/schema; every tunable lives in
-- matching_config (CLAUDE.md), and 0028 was already applied to the preview
-- database, so the row comes in its own file (ADR-009 §4). The seed carries the
-- same row (packages/db/src/seed.ts; migrate.test.ts keeps the two identical).
-- A new number is a new version, never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'photo_tip_photos_suggested', '3'::jsonb, 'migration:0029')
ON CONFLICT ("key", "version") DO NOTHING;
