-- Custom SQL migration file, put your code below! --
-- matching_config version 1 rows for the photos of #350 (ADR-031 §10,
-- apps/api/src/chat/photos.ts): the photos one account may send in
-- conversations per Finnish calendar day, counted in the statement that
-- writes the photo under the account's lock (#101's table states 10); and
-- the sends it may try in a day, refused ones included, which the route's
-- limiter counts, since a refused photo is stored nowhere and still costs
-- the pipeline and the check. The seed carries the same rows
-- (packages/db/src/seed.ts; migrate.test.ts keeps the two identical). A new
-- number is a new version, written by an admin in the panel (#305), never an
-- edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'message_photos_per_day', '10'::jsonb, 'migration:0057'),
  (1, 'message_photo_attempts_per_day', '30'::jsonb, 'migration:0057')
ON CONFLICT ("key", "version") DO NOTHING;
