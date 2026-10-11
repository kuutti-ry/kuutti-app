-- Custom SQL migration file, put your code below! --
-- matching_config version 1 row for the one country-wide pond (#146, ADR-010
-- §10): the slug of the pond every account is put in when it has none, so
-- that onboarding has no pond step for now. The ponds row itself comes from
-- the seed (packages/db/src/seed.ts, which carries this row too;
-- migrate.test.ts keeps the two identical). Several ponds later is a new
-- version with null, never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'default_pond', '"suomi"'::jsonb, 'migration:0020')
ON CONFLICT ("key", "version") DO NOTHING;
