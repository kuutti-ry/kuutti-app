-- Custom SQL migration file, put your code below! --
-- matching_config version 2 of default_pond (ADR-010 §11): the one pond is
-- the capital region, paakaupunkiseutu, a row every environment has carried
-- since its first ponds. The country-wide pond of version 1 (migration 0020)
-- was chosen for size alone and existed in seeded databases only; version 1
-- keeps its row, the latest version wins (apps/api/src/lib/matching-config.ts).
-- The seed writes the same row (packages/db/src/seed.ts; migrate.test.ts keeps
-- the two identical). Several ponds later is a new version with null, never an
-- edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (2, 'default_pond', '"paakaupunkiseutu"'::jsonb, 'migration:0025')
ON CONFLICT ("key", "version") DO NOTHING;
