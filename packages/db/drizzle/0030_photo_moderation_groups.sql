-- Custom SQL migration file, put your code below! ---- matching_config version 1 rows for the hard groups of moderation labels
-- (#253, ADR-006 §2, apps/api/src/media/label-groups.ts): from `review` a
-- person looks, from `reject` the check rejects the photo itself and tells the
-- owner why. The maintainer's lines of 12/10/2026: 60 and 90 for each group.
-- photo_moderation_label_threshold (0007) stays, as the line from which a
-- label the check does not know goes to a person. The seed carries the same
-- rows (packages/db/src/seed.ts; migrate.test.ts keeps the two identical).
-- A new number is a new version, never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'photo_moderation_nudity_review', '60'::jsonb, 'migration:0030'),
  (1, 'photo_moderation_nudity_reject', '90'::jsonb, 'migration:0030'),
  (1, 'photo_moderation_violence_review', '60'::jsonb, 'migration:0030'),
  (1, 'photo_moderation_violence_reject', '90'::jsonb, 'migration:0030'),
  (1, 'photo_moderation_disturbing_review', '60'::jsonb, 'migration:0030'),
  (1, 'photo_moderation_disturbing_reject', '90'::jsonb, 'migration:0030'),
  (1, 'photo_moderation_hate_review', '60'::jsonb, 'migration:0030'),
  (1, 'photo_moderation_hate_reject', '90'::jsonb, 'migration:0030')
ON CONFLICT ("key", "version") DO NOTHING;
