-- Custom SQL migration file, put your code below! --
-- matching_config version 1 row for the report from a conversation (#351,
-- ADR-030 §12, apps/api/src/safety/reports.ts): the days after a
-- conversation closed during which either person may still report it, so a
-- block cannot be used to dodge a report (ADR-030 §2). #101's table states
-- 30, the maintainer confirmed it on 18/10/2026. The seed carries the same
-- row (packages/db/src/seed.ts; migrate.test.ts keeps the two identical). A
-- new number is a new version, written by an admin in the panel (#305),
-- never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'report_after_close_days', '30'::jsonb, 'migration:0061')
ON CONFLICT ("key", "version") DO NOTHING;
