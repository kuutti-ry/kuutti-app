-- Custom SQL migration file, put your code below! --
-- matching_config version 1 rows for the invitations of #107 (ADR-044,
-- apps/api/src/rewards/): what an invitation that counted earns its inviter,
-- one fish and no likes, the maintainer's default of 22/10/2026, each kind
-- switched off by 0; how many unredeemed invitations a person may hold at
-- once; and how many codes a person may try a Finnish day, those two the
-- build's (ADR-044 Open). The code's ten characters are a format
-- (INVITATION_CODE_LENGTH in packages/schema), not a tunable. The seed
-- carries the same rows (packages/db/src/seed.ts; migrate.test.ts keeps the
-- two identical). A new value is a new version, written by an admin in the
-- panel (#305), never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'invitation_reward', '{"fish": 1, "likes": 0}'::jsonb, 'migration:0080'),
  (1, 'invitations_open', '5'::jsonb, 'migration:0080'),
  (1, 'invitation_tries_per_day', '5'::jsonb, 'migration:0080')
ON CONFLICT ("key", "version") DO NOTHING;
