-- Custom SQL migration file, put your code below! --
-- The push of #102 (ADR-055 §3 and §10). A device's push token goes the
-- moment its session is revoked, whichever statement revokes it: a sign-out,
-- "sign out everywhere", the app lock's way out, a sanction, a break or a
-- refresh token's reuse (apps/api/src/identity/repo.ts and standing.ts today,
-- any later one too). A deleted session takes its token by 0081's cascade.
CREATE FUNCTION push_token_session_revoked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM push_token WHERE session_id = NEW.id;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER session_revoked_push_token AFTER UPDATE OF revoked_at ON session
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION push_token_session_revoked();--> statement-breakpoint

-- matching_config version 1 rows for the push (the issue's proposals, the
-- maintainer's of 25/10/2026): at most one push of a conversation to its
-- recipient in message_push_min_interval_minutes; no push of any kind from
-- push_quiet_from_hour to push_quiet_to_hour in Helsinki, equal hours meaning
-- none; the round's push at round_push_hour in Helsinki. The seed carries the
-- same rows (packages/db/src/seed.ts; migrate.test.ts keeps the two
-- identical). A new value is a new version, written by an admin in the panel
-- (#305), never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'message_push_min_interval_minutes', '10'::jsonb, 'migration:0082'),
  (1, 'push_quiet_from_hour', '22'::jsonb, 'migration:0082'),
  (1, 'push_quiet_to_hour', '8'::jsonb, 'migration:0082'),
  (1, 'round_push_hour', '9'::jsonb, 'migration:0082')
ON CONFLICT ("key", "version") DO NOTHING;
