-- Custom SQL migration file, put your code below! ----
-- matching_config version 1 row for the feedback of #171 (ADR-023,
-- apps/api/src/safety/feedback.ts): feedback a person may send per Finnish
-- calendar day, counted from feedback in the statement that writes the row;
-- the next one is refused in words. The issue's number: five. The seed
-- carries the same row (packages/db/src/seed.ts; migrate.test.ts keeps the
-- two identical). A new number is a new version, never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'feedback_per_day', '5'::jsonb, 'migration:0042')
ON CONFLICT ("key", "version") DO NOTHING;
