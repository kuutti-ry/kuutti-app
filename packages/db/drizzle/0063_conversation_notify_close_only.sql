-- Custom SQL migration file, put your code below! --
-- The conversation's notification (migration 0055) only when what either
-- person reads changes: archived, back from the archive, or closed (#351,
-- ADR-030 §6 and §12, ADR-031 §5). A block or a report on a conversation
-- that has ended rewrites its closed_how and closed_by alone, as the block's,
-- so that its blocker never sees it again; a notification for that told the
-- other person, the one who ended it among them, that something happened
-- after the end. The blocker's own frame comes through the block's
-- notification (block_notify), which the listener sends to the blocker's
-- side only.
DROP TRIGGER conversation_notify ON conversation;--> statement-breakpoint
CREATE TRIGGER conversation_notify AFTER UPDATE ON conversation
  FOR EACH ROW
  WHEN (OLD.archived_at IS DISTINCT FROM NEW.archived_at
     OR OLD.closed_at IS DISTINCT FROM NEW.closed_at)
  EXECUTE FUNCTION chat_notify_conversation();
