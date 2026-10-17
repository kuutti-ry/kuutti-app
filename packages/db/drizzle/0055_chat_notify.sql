-- Custom SQL migration file, put your code below! --
-- The chat's socket (#349, ADR-031 §5 and its amendment of 2026-10-17): what
-- changed reaches the phones when it is committed, from whichever path wrote
-- it. Each trigger sends a notification on the channel kuutti_chat with ids
-- and numbers only, never a message's text (rule 5); Postgres delivers it to
-- the API's listener when the transaction commits, and drops it when it rolls
-- back. The listener reads what each recipient may see through that
-- recipient's own participant row (apps/api/src/chat/live.ts).

-- A message: its conversation and sequence.
CREATE FUNCTION chat_notify_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('kuutti_chat',
    json_build_object('t', 'message', 'c', NEW.conversation_id, 's', NEW.seq)::text);
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER message_notify AFTER INSERT ON message
  FOR EACH ROW EXECUTE FUNCTION chat_notify_message();--> statement-breakpoint

-- A conversation archived, back from the archive, or closed.
CREATE FUNCTION chat_notify_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('kuutti_chat', json_build_object('t', 'conversation', 'c', NEW.id)::text);
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER conversation_notify AFTER UPDATE ON conversation
  FOR EACH ROW
  WHEN (OLD.archived_at IS DISTINCT FROM NEW.archived_at
     OR OLD.closed_at IS DISTINCT FROM NEW.closed_at
     OR OLD.closed_how IS DISTINCT FROM NEW.closed_how
     OR OLD.closed_by IS DISTINCT FROM NEW.closed_by)
  EXECUTE FUNCTION chat_notify_conversation();--> statement-breakpoint

-- A read mark moved: the conversation, the reader's side, the new mark.
CREATE FUNCTION chat_notify_read() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('kuutti_chat',
    json_build_object('t', 'read', 'c', NEW.conversation_id, 'side', NEW.side, 'u', NEW.read_up_to)::text);
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER conversation_participant_notify AFTER UPDATE ON conversation_participant
  FOR EACH ROW WHEN (OLD.read_up_to IS DISTINCT FROM NEW.read_up_to)
  EXECUTE FUNCTION chat_notify_read();--> statement-breakpoint

-- A session ended, revoked or deleted: its sockets close at once.
CREATE FUNCTION chat_notify_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('kuutti_chat', json_build_object('t', 'session', 'id', OLD.id)::text);
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER session_revoked_notify AFTER UPDATE ON session
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION chat_notify_session();--> statement-breakpoint
CREATE TRIGGER session_deleted_notify AFTER DELETE ON session
  FOR EACH ROW EXECUTE FUNCTION chat_notify_session();--> statement-breakpoint

-- A block: the two identities, whose conversations it ends.
CREATE FUNCTION chat_notify_block() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('kuutti_chat',
    json_build_object('t', 'block', 'a', NEW.blocker_identity_id, 'b', NEW.blocked_identity_id)::text);
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER block_notify AFTER INSERT ON block
  FOR EACH ROW EXECUTE FUNCTION chat_notify_block();
