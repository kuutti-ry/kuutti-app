-- Custom SQL migration file, put your code below! --
-- matching_config version 1 of the most stars a person's list may hold (#575,
-- ADR-064 §5): ten, the same as a day's likes, so the list can be emptied in a day,
-- the maintainer's of 03/11/2026. The seed carries the same row
-- (packages/db/src/seed.ts; migrate.test.ts keeps the two identical). A new value
-- is a new version, written by an admin in the panel (#305), never an edit of this
-- file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'stars_max', '10'::jsonb, 'migration:0108')
ON CONFLICT ("key", "version") DO NOTHING;
