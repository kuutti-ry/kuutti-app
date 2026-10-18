-- Custom SQL migration file, put your code below! --
-- Contacts shared in a conversation (#103, ADR-031 §11), on the chat's
-- channel as migration 0055's triggers are: the conversation's id only,
-- never a contact (rule 5's reasoning: a notification carries ids and
-- numbers). The listener tells both people's phones to read the
-- conversation again, each through their own participant row
-- (apps/api/src/chat/live.ts).

-- A share begun or ended.
CREATE FUNCTION chat_notify_contact_share() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('kuutti_chat', json_build_object('t', 'contact', 'c', NEW.conversation_id)::text);
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER contact_share_notify AFTER INSERT OR UPDATE ON contact_share
  FOR EACH ROW EXECUTE FUNCTION chat_notify_contact_share();--> statement-breakpoint

-- A stored piece changed while it is shared: every conversation it stands
-- in. A removed piece ends its shares in the same transaction, which the
-- trigger above announces.
CREATE FUNCTION chat_notify_contact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('kuutti_chat', json_build_object('t', 'contact', 'c', s.conversation_id)::text)
  FROM contact_share s
  JOIN conversation_participant p ON p.conversation_id = s.conversation_id AND p.side = s.side
  WHERE p.account_id = NEW.account_id AND s.kind = NEW.kind AND s.ended_at IS NULL;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER contact_notify AFTER UPDATE ON contact
  FOR EACH ROW WHEN (OLD.value IS DISTINCT FROM NEW.value)
  EXECUTE FUNCTION chat_notify_contact();
