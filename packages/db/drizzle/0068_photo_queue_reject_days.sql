-- Custom SQL migration file, put your code below! --
-- matching_config version 1 row for the photo queue's limit (#376, ADR-006
-- §2, apps/api/src/media/moderation.ts): a photo that has waited this many
-- days for a person, from its upload or its owner's appeal, is rejected by the
-- night as not reviewed. The maintainer's number of 20/10/2026: two weeks. The
-- seed carries the same row (packages/db/src/seed.ts; migrate.test.ts keeps
-- the two identical). A new number is a new version, written by an admin in
-- the panel (#305), never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'photo_queue_reject_days', '14'::jsonb, 'migration:0068')
ON CONFLICT ("key", "version") DO NOTHING;
