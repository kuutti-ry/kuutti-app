-- Custom SQL migration file, put your code below! --
-- What a database starts with that the schema DSL cannot say (rule 10): the
-- triggers, the functions and the partitioned events table, then the one pond
-- and the tunables. The chain before this folder was folded into these two
-- files while no real person's row existed anywhere (ADR-065); what each
-- piece was for is in the ADR it names, and its first form in git history.

-- audit_log is append-only (TD-5, #49, ADR-006): a grant cannot stop the table's
-- owner from rewriting rows, so a trigger refuses UPDATE, DELETE and TRUNCATE,
-- and dropping it is a migration that goes through review. What a trigger cannot
-- stop is its owner disabling it, which infra/scripts/db-audit-owner.sh closes
-- on a deployed database by handing the table to a role the API never connects as.
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % refused', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER audit_log_no_update_or_delete
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();--> statement-breakpoint
-- TRUNCATE fires no row trigger; it needs its own, statement-level one.
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();--> statement-breakpoint

-- The research events (#50, TD-5, ADR-011; rules/db.md): append-only, monthly
-- partitions, 90-day retention, keyed by research_id and never by account_id.
-- The DSL cannot express PARTITION BY. The partitions (events_YYYY_MM) are made
-- ahead by the API at boot and nightly (apps/api/src/research/partitions.ts), and
-- retention is a DROP of a whole partition. No row is ever updated or deleted,
-- and the triggers below refuse the attempt, as on audit_log. There is no foreign
-- key to research_subject: the events outlive the mapping row, unlinkable once
-- it is gone. pond is null for an event before the person has a home (ADR-010 §9).
CREATE TABLE "events" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "at" timestamp with time zone NOT NULL,
  "name" text NOT NULL,
  "research_id" uuid NOT NULL,
  "consent_version" text NOT NULL,
  "pond" text,
  "age_band" text NOT NULL,
  "snapshot" jsonb NOT NULL,
  "props" jsonb NOT NULL,
  PRIMARY KEY ("at", "id")
) PARTITION BY RANGE ("at");--> statement-breakpoint
CREATE INDEX "events_research_id_at_idx" ON "events" ("research_id", "at");--> statement-breakpoint
CREATE INDEX "events_name_at_idx" ON "events" ("name", "at");--> statement-breakpoint
CREATE FUNCTION events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only: % refused', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
-- A row trigger on a partitioned table is cloned onto every partition, present and future.
CREATE TRIGGER events_no_update_or_delete
  BEFORE UPDATE OR DELETE ON "events"
  FOR EACH ROW EXECUTE FUNCTION events_immutable();--> statement-breakpoint
-- TRUNCATE fires no row trigger; this one guards the statement on the parent.
CREATE TRIGGER events_no_truncate
  BEFORE TRUNCATE ON "events"
  FOR EACH STATEMENT EXECUTE FUNCTION events_immutable();--> statement-breakpoint

-- blocked_between(a, b) (#84, ADR-030 §2): whether a block stands between the
-- identities of two accounts, in either direction. A block is kept between
-- identities so that it holds for a later account of either. Every read that
-- shows one person to another asks it with the viewer's account id and the
-- subject's, so the clause is written once and no other slice reads the safety
-- slice's table. Symmetric by construction. STABLE and read-only: two lookups on
-- the pair index per call. A SQL-standard body (BEGIN ATOMIC) rather than a
-- string: Postgres parses it here and records what it reads, so a later migration
-- cannot drop or retype block or account's columns under it without saying so.
CREATE FUNCTION blocked_between(a uuid, b uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE
BEGIN ATOMIC
  SELECT EXISTS (
    SELECT 1 FROM account x, account y, block bl
    WHERE x.id = a AND y.id = b
      AND ((bl.blocker_identity_id = x.identity_id AND bl.blocked_identity_id = y.identity_id)
        OR (bl.blocker_identity_id = y.identity_id AND bl.blocked_identity_id = x.identity_id)));
END;--> statement-breakpoint

-- The chat's socket (#349, ADR-031 §9): what changed reaches the phones when it
-- is committed, from whichever path wrote it. Each trigger sends a notification
-- on the channel kuutti_chat with ids and numbers only, never a message's text
-- or a contact; Postgres delivers it to the API's listener when the transaction
-- commits, and drops it when it rolls back. The listener reads what each recipient
-- may see through that recipient's own participant row (apps/api/src/chat/live.ts).

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

-- A conversation archived, back from the archive, or closed: only when what either
-- person reads changes (#351, ADR-030 §6 and §12). A block or a report on a
-- conversation that has ended rewrites its closed_how and closed_by alone, as the
-- block's, so that its blocker never sees it again; a notification for that would
-- tell the other person, the one who ended it among them, that something happened
-- after the end. The blocker's own frame comes through block_notify, which the
-- listener sends to the blocker's side only.
CREATE FUNCTION chat_notify_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('kuutti_chat', json_build_object('t', 'conversation', 'c', NEW.id)::text);
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER conversation_notify AFTER UPDATE ON conversation
  FOR EACH ROW
  WHEN (OLD.archived_at IS DISTINCT FROM NEW.archived_at
     OR OLD.closed_at IS DISTINCT FROM NEW.closed_at)
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
  FOR EACH ROW EXECUTE FUNCTION chat_notify_block();--> statement-breakpoint

-- A contact's share begun or ended (#103, ADR-031 §11): the conversation's id only.
CREATE FUNCTION chat_notify_contact_share() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('kuutti_chat', json_build_object('t', 'contact', 'c', NEW.conversation_id)::text);
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER contact_share_notify AFTER INSERT OR UPDATE ON contact_share
  FOR EACH ROW EXECUTE FUNCTION chat_notify_contact_share();--> statement-breakpoint

-- A stored piece changed while it is shared: every conversation it stands in. A
-- removed piece ends its shares in the same transaction, which the trigger above
-- announces.
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
  EXECUTE FUNCTION chat_notify_contact();--> statement-breakpoint

-- A device's push token goes the moment its session is revoked, whichever statement
-- revokes it (#102, ADR-055 §3): a sign-out, "sign out everywhere", the app lock's
-- way out, a sanction, a break or a refresh token's reuse. A deleted session takes
-- its token by the foreign key's cascade.
CREATE FUNCTION push_token_session_revoked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM push_token WHERE session_id = NEW.id;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER session_revoked_push_token AFTER UPDATE OF revoked_at ON session
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION push_token_session_revoked();--> statement-breakpoint

-- The one pond, the whole country, closed until somebody opens it in the panel
-- (ADR-060, ADR-061 §8). Every database has it: the API sets it with a person's home.
INSERT INTO "ponds" ("slug", "name_nominative") VALUES ('suomi', 'Suomi');--> statement-breakpoint

-- The tunables, each at the value it stood at when the chain was folded. What each
-- is for and who decided it is its row in docs/decisions.md. The seed's
-- MATCHING_CONFIG_V1 carries the same rows (migrate.test.ts keeps the two identical).
-- A new value is a new version, by an admin in the panel with a reason or by a
-- migration naming itself, never an edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'like_budget_balanced', '10'::jsonb, 'migration:0001'),
  (1, 'like_expiry_days', '14'::jsonb, 'migration:0001'),
  (1, 'pass_cooldown_days', '30'::jsonb, 'migration:0001'),
  (1, 'silent_match_archive_days', '7'::jsonb, 'migration:0001'),
  (1, 'max_photos', '6'::jsonb, 'migration:0001'),
  (1, 'photo_moderation_label_threshold', '60'::jsonb, 'migration:0001'),
  (1, 'photo_moderation_face_threshold', '90'::jsonb, 'migration:0001'),
  (1, 'photo_moderation_nudity_review', '60'::jsonb, 'migration:0001'),
  (1, 'photo_moderation_nudity_reject', '90'::jsonb, 'migration:0001'),
  (1, 'photo_moderation_violence_review', '60'::jsonb, 'migration:0001'),
  (1, 'photo_moderation_violence_reject', '90'::jsonb, 'migration:0001'),
  (1, 'photo_moderation_disturbing_review', '60'::jsonb, 'migration:0001'),
  (1, 'photo_moderation_disturbing_reject', '90'::jsonb, 'migration:0001'),
  (1, 'photo_moderation_hate_review', '60'::jsonb, 'migration:0001'),
  (1, 'photo_moderation_hate_reject', '90'::jsonb, 'migration:0001'),
  (1, 'photo_moderation_nudity_no_appeal', '95'::jsonb, 'migration:0001'),
  (1, 'photo_closer_look_attempts', '2'::jsonb, 'migration:0001'),
  (1, 'photo_closer_look_window_days', '30'::jsonb, 'migration:0001'),
  (1, 'photo_closer_look_days', '30'::jsonb, 'migration:0001'),
  (1, 'photo_closer_look_reject', '75'::jsonb, 'migration:0001'),
  (1, 'photo_queue_reject_days', '14'::jsonb, 'migration:0001'),
  (1, 'fish_budget', '1'::jsonb, 'migration:0001'),
  (1, 'fish_window_days', '7'::jsonb, 'migration:0001'),
  (1, 'photo_tip_mirror_confidence_min', '50'::jsonb, 'migration:0001'),
  (1, 'photo_tip_bathroom_confidence_min', '50'::jsonb, 'migration:0001'),
  (1, 'photo_tip_sunglasses_confidence_min', '50'::jsonb, 'migration:0001'),
  (1, 'photo_tip_tight_crop_face_area_min', '0.4'::jsonb, 'migration:0001'),
  (1, 'photo_tip_brightness_below', '40'::jsonb, 'migration:0001'),
  (1, 'photo_tip_sharpness_below', '20'::jsonb, 'migration:0001'),
  (1, 'photo_tip_group_photo_min_faces', '2'::jsonb, 'migration:0001'),
  (1, 'photo_tip_photos_suggested', '3'::jsonb, 'migration:0001'),
  (1, 'photo_tip_revealing_confidence_min', '80'::jsonb, 'migration:0001'),
  (1, 'photo_tip_fish_confidence_min', '80'::jsonb, 'migration:0001'),
  (1, 'photo_tip_fish_species_min', '70'::jsonb, 'migration:0001'),
  (1, 'photo_description_confidence_min', '80'::jsonb, 'migration:0001'),
  (1, 'exposure_cards_per_day', '0'::jsonb, 'migration:0001'),
  (1, 'photo_fetches_per_day', '{"thumb":600,"card":0,"full":60}'::jsonb, 'migration:0001'),
  (1, 'exports_per_day', '3'::jsonb, 'migration:0001'),
  (1, 'feedback_per_day', '5'::jsonb, 'migration:0001'),
  (1, 'email_code_minutes', '30'::jsonb, 'migration:0001'),
  (1, 'email_code_attempts', '3'::jsonb, 'migration:0001'),
  (1, 'email_codes_per_day', '5'::jsonb, 'migration:0001'),
  (1, 'invitation_reward', '{"inviterFish":1,"friendFish":1}'::jsonb, 'migration:0001'),
  (1, 'invitations_open', '5'::jsonb, 'migration:0001'),
  (1, 'invitation_tries_per_day', '5'::jsonb, 'migration:0001'),
  (1, 'message_push_min_interval_minutes', '10'::jsonb, 'migration:0001'),
  (1, 'push_quiet_from_hour', '22'::jsonb, 'migration:0001'),
  (1, 'push_quiet_to_hour', '8'::jsonb, 'migration:0001'),
  (1, 'moderation_response_hours', '24'::jsonb, 'migration:0001'),
  (1, 'reports_per_day', '5'::jsonb, 'migration:0001'),
  (1, 'report_after_close_days', '30'::jsonb, 'migration:0001'),
  (1, 'auto_shadow_ban_reports', '3'::jsonb, 'migration:0001'),
  (1, 'auto_shadow_ban_reports_days', '7'::jsonb, 'migration:0001'),
  (1, 'auto_shadow_ban_first_messages', '20'::jsonb, 'migration:0001'),
  (1, 'auto_shadow_ban_first_messages_minutes', '60'::jsonb, 'migration:0001'),
  (1, 'auto_shadow_ban_same_first_message', '5'::jsonb, 'migration:0001'),
  (1, 'auto_shadow_ban_same_first_message_hours', '24'::jsonb, 'migration:0001'),
  (1, 'auto_shadow_ban_review_hours', '48'::jsonb, 'migration:0001'),
  (1, 'auto_shadow_ban_photo_fetches', '1500'::jsonb, 'migration:0001'),
  (1, 'auto_shadow_ban_photo_fetches_minutes', '60'::jsonb, 'migration:0001'),
  (1, 'auto_shadow_ban_cards_served', '300'::jsonb, 'migration:0001'),
  (1, 'auto_shadow_ban_cards_served_minutes', '10'::jsonb, 'migration:0001'),
  (1, 'auto_shadow_ban_round_reads', '30'::jsonb, 'migration:0001'),
  (1, 'auto_shadow_ban_round_reads_minutes', '1'::jsonb, 'migration:0001'),
  (1, 'message_max_length', '2000'::jsonb, 'migration:0001'),
  (1, 'messages_per_minute', '30'::jsonb, 'migration:0001'),
  (1, 'message_photos_per_day', '10'::jsonb, 'migration:0001'),
  (1, 'message_photo_attempts_per_day', '30'::jsonb, 'migration:0001'),
  (1, 'pond_counter_k', '10'::jsonb, 'migration:0001'),
  (1, 'change_cadence_days', '30'::jsonb, 'migration:0001'),
  (1, 'deal_breakers_max', '7'::jsonb, 'migration:0001'),
  (1, 'home_min_inhabitants', '3000'::jsonb, 'migration:0001'),
  (1, 'home_town_min_inhabitants', '20000'::jsonb, 'migration:0001'),
  (1, 'distance_nearby_km', '5'::jsonb, 'migration:0001'),
  (1, 'distance_close_km', '15'::jsonb, 'migration:0001'),
  (1, 'distance_around_km', '50'::jsonb, 'migration:0001'),
  (1, 'liked_cooldown_days', '90'::jsonb, 'migration:0001'),
  (1, 'ended_cooldown_days', '90'::jsonb, 'migration:0001'),
  (1, 'second_pass_cooldown_days', '365'::jsonb, 'migration:0001'),
  (1, 'your_turn_limit', '8'::jsonb, 'migration:0001'),
  (1, 'your_turn_warning', '6'::jsonb, 'migration:0001'),
  (1, 'inbox_stop', '30'::jsonb, 'migration:0001'),
  (1, 'stars_max', '10'::jsonb, 'migration:0001');
