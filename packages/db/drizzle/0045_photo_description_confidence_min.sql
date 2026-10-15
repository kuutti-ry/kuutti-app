-- Custom SQL migration file, put your code below! ----
-- matching_config version 1 row for the automatic photo description of #296
-- (ADR-006 §3, apps/api/src/media/description.ts): a scene or object label,
-- indoors or outdoors, and a face attribute (a smile, glasses, sunglasses,
-- facial hair) are said only from this Rekognition confidence. The seed
-- carries the same row (packages/db/src/seed.ts; migrate.test.ts keeps the
-- two identical). A new number is a new version, never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'photo_description_confidence_min', '80'::jsonb, 'migration:0045')
ON CONFLICT ("key", "version") DO NOTHING;
