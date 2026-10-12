-- Custom SQL migration file, put your code below! ---- matching_config version 1 row for the appeal of #253 (ADR-006 §2): a
-- nudity label at or above this confidence leaves the owner no "ask a person
-- to look", so no moderator is sent a picture the check was this sure of.
-- The maintainer's line of 12/10/2026: 95. The seed carries the same row
-- (packages/db/src/seed.ts; migrate.test.ts keeps the two identical).
-- A new number is a new version, never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'photo_moderation_nudity_no_appeal', '95'::jsonb, 'migration:0033')
ON CONFLICT ("key", "version") DO NOTHING;
