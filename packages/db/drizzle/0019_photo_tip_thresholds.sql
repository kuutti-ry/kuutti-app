-- Custom SQL migration file, put your code below! --
-- matching_config version 1 rows for profile photo tips (#56): label confidence
-- floors per scene kind, face-area / brightness / sharpness cutoffs, and the
-- face count at which a photo counts as a group. Tip signals are stored at
-- moderation time (ADR-006); these rows are what the tips rule reads later.
-- The seed carries the same rows (packages/db/src/seed.ts; migrate.test.ts
-- keeps the two identical). A new number is a new version, never an edit of
-- this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'photo_tip_mirror_confidence_min', '50'::jsonb, 'migration:0019'),
  (1, 'photo_tip_bathroom_confidence_min', '50'::jsonb, 'migration:0019'),
  (1, 'photo_tip_sunglasses_confidence_min', '50'::jsonb, 'migration:0019'),
  (1, 'photo_tip_tight_crop_face_area_min', '0.4'::jsonb, 'migration:0019'),
  (1, 'photo_tip_brightness_below', '40'::jsonb, 'migration:0019'),
  (1, 'photo_tip_sharpness_below', '20'::jsonb, 'migration:0019'),
  (1, 'photo_tip_group_photo_min_faces', '2'::jsonb, 'migration:0019')
ON CONFLICT ("key", "version") DO NOTHING;
