-- Custom SQL migration file, put your code below! --
-- matching_config version 1 rows for confirming the optional e-mail (#385,
-- ADR-043, apps/api/src/identity/email.ts), the maintainer's of 20/10/2026: a
-- code works for thirty minutes and for three wrong attempts, and an account
-- is sent at most five codes a Finnish day. The code's six digits are a format
-- (EMAIL_CODE_LENGTH in packages/schema), not a tunable. The seed carries the
-- same rows (packages/db/src/seed.ts; migrate.test.ts keeps the two
-- identical). A new number is a new version, written by an admin in the panel
-- (#305), never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'email_code_minutes', '30'::jsonb, 'migration:0078'),
  (1, 'email_code_attempts', '3'::jsonb, 'migration:0078'),
  (1, 'email_codes_per_day', '5'::jsonb, 'migration:0078')
ON CONFLICT ("key", "version") DO NOTHING;
