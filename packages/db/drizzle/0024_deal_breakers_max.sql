-- Custom SQL migration file, put your code below! --
-- matching_config version 1 row for the deal-breakers (#149, TD-16, the field
-- sheet's disclose-to-filter rule): how many a person may set; two at launch,
-- so a small pond is not cut to nothing. The seed carries the same row
-- (packages/db/src/seed.ts; migrate.test.ts keeps the two identical). A new
-- number is a new version, never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'deal_breakers_max', '2'::jsonb, 'migration:0024')
ON CONFLICT ("key", "version") DO NOTHING;
