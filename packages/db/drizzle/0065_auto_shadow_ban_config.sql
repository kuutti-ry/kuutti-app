-- Custom SQL migration file, put your code below! --
-- matching_config version 1 rows for the automatic shadow bans (#105,
-- ADR-033, apps/api/src/safety/automatic.ts), the maintainer's of
-- 19/10/2026: three reports by different people in seven days; twenty first
-- messages in sixty minutes; the same first message to five people within
-- twenty-four hours, with no minimum length; and forty-eight hours for a
-- moderator's review. A threshold of 0 switches its rule off. The seed
-- carries the same rows (packages/db/src/seed.ts; migrate.test.ts keeps the
-- two identical). A new number is a new version, written by an admin in the
-- panel (#305), never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'auto_shadow_ban_reports', '3'::jsonb, 'migration:0065'),
  (1, 'auto_shadow_ban_reports_days', '7'::jsonb, 'migration:0065'),
  (1, 'auto_shadow_ban_first_messages', '20'::jsonb, 'migration:0065'),
  (1, 'auto_shadow_ban_first_messages_minutes', '60'::jsonb, 'migration:0065'),
  (1, 'auto_shadow_ban_same_first_message', '5'::jsonb, 'migration:0065'),
  (1, 'auto_shadow_ban_same_first_message_hours', '24'::jsonb, 'migration:0065'),
  (1, 'auto_shadow_ban_review_hours', '48'::jsonb, 'migration:0065')
ON CONFLICT ("key", "version") DO NOTHING;
