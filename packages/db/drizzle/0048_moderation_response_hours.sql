-- Custom SQL migration file, put your code below! ----
-- matching_config version 1 row for the panel's front page of #303
-- (apps/api/src/safety/overview-routes.ts): the hours the association promises to
-- answer within, against which the oldest item of each queue is said to be
-- late (#299's moderation runbook, App Review's expectation of a day). The
-- issue's number: 24. The seed carries the same row (packages/db/src/seed.ts;
-- migrate.test.ts keeps the two identical). A new number is a new version,
-- written by an admin in the panel (#305), never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'moderation_response_hours', '24'::jsonb, 'migration:0048')
ON CONFLICT ("key", "version") DO NOTHING;
