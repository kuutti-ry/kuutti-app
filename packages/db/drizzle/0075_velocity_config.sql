-- Custom SQL migration file, put your code below! --
-- matching_config version 1 rows for the velocity rules (#86, ADR-041,
-- apps/api/src/safety/automatic.ts), the maintainer's of 21/10/2026: 120
-- URLs of other people's photos in the card and full sizes within 60
-- minutes; cards served, switched off (0) within 60 minutes, since the round
-- bounds them; and 30 reads of the day's round within one minute. A
-- threshold of 0 switches its rule off. The seed carries the same rows
-- (packages/db/src/seed.ts; migrate.test.ts keeps the two identical). A new
-- number is a new version, written by an admin in the panel (#305), never an
-- edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'auto_shadow_ban_photo_fetches', '120'::jsonb, 'migration:0075'),
  (1, 'auto_shadow_ban_photo_fetches_minutes', '60'::jsonb, 'migration:0075'),
  (1, 'auto_shadow_ban_cards_served', '0'::jsonb, 'migration:0075'),
  (1, 'auto_shadow_ban_cards_served_minutes', '60'::jsonb, 'migration:0075'),
  (1, 'auto_shadow_ban_round_reads', '30'::jsonb, 'migration:0075'),
  (1, 'auto_shadow_ban_round_reads_minutes', '1'::jsonb, 'migration:0075')
ON CONFLICT ("key", "version") DO NOTHING;
