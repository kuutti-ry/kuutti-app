CREATE TYPE "public"."account_state" AS ENUM('registered', 'active', 'paused', 'shadow_banned', 'suspended', 'banned', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."consent_kind" AS ENUM('terms', 'privacy', 'research', 'special_category');--> statement-breakpoint
CREATE TYPE "public"."contact_kind" AS ENUM('phone', 'whatsapp', 'telegram', 'instagram', 'snapchat');--> statement-breakpoint
CREATE TYPE "public"."contact_share_end" AS ENUM('stopped', 'removed', 'closed');--> statement-breakpoint
CREATE TYPE "public"."conversation_close" AS ENUM('block', 'unmatch', 'erasure', 'sanction');--> statement-breakpoint
CREATE TYPE "public"."conversation_side" AS ENUM('a', 'b');--> statement-breakpoint
CREATE TYPE "public"."distance_band" AS ENUM('nearby', 'close', 'around', 'far');--> statement-breakpoint
CREATE TYPE "public"."feedback_kind" AS ENUM('bug', 'idea', 'complaint', 'praise');--> statement-breakpoint
CREATE TYPE "public"."feedback_platform" AS ENUM('ios', 'android', 'web');--> statement-breakpoint
CREATE TYPE "public"."found_reason" AS ENUM('here', 'elsewhere', 'other');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('woman', 'man', 'non_binary');--> statement-breakpoint
CREATE TYPE "public"."identity_standing" AS ENUM('ok', 'suspended', 'banned');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('text', 'photo');--> statement-breakpoint
CREATE TYPE "public"."moderator_role" AS ENUM('moderator', 'admin', 'researcher');--> statement-breakpoint
CREATE TYPE "public"."notice_kind" AS ENUM('warning', 'invitation_counted', 'invitation_friend');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('message', 'match', 'moderation');--> statement-breakpoint
CREATE TYPE "public"."photo_check_kind" AS ENUM('nudity', 'violence', 'disturbing', 'hate');--> statement-breakpoint
CREATE TYPE "public"."photo_decision" AS ENUM('approved', 'queued', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."photo_purpose" AS ENUM('profile', 'message');--> statement-breakpoint
CREATE TYPE "public"."photo_rejection_reason" AS ENUM('nudity', 'no_person', 'several_people', 'minor', 'violence', 'contact_details', 'other', 'not_reviewed');--> statement-breakpoint
CREATE TYPE "public"."photo_state" AS ENUM('pending', 'approved', 'queued', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."photo_variant" AS ENUM('thumb', 'card', 'full');--> statement-breakpoint
CREATE TYPE "public"."preference_mode" AS ENUM('hard', 'soft');--> statement-breakpoint
CREATE TYPE "public"."push_platform" AS ENUM('ios', 'android');--> statement-breakpoint
CREATE TYPE "public"."relaxation_kind" AS ENUM('unanswered', 'aside');--> statement-breakpoint
CREATE TYPE "public"."report_message_side" AS ENUM('reporter', 'reported');--> statement-breakpoint
CREATE TYPE "public"."report_outcome" AS ENUM('dismissed', 'acted');--> statement-breakpoint
CREATE TYPE "public"."report_source" AS ENUM('card', 'conversation');--> statement-breakpoint
CREATE TYPE "public"."reward_kind" AS ENUM('fish');--> statement-breakpoint
CREATE TYPE "public"."round_decision" AS ENUM('like', 'pass', 'skip');--> statement-breakpoint
CREATE TYPE "public"."round_reason" AS ENUM('matches_filters', 'liked_you', 'seen_before', 'relaxed', 'fish');--> statement-breakpoint
CREATE TYPE "public"."sanction_kind" AS ENUM('warn', 'shadow_ban', 'suspend', 'ban');--> statement-breakpoint
CREATE TYPE "public"."sanction_reason" AS ENUM('harassment', 'misrepresentation', 'under_age', 'commercial_use', 'scraping', 'other');--> statement-breakpoint
CREATE TYPE "public"."sanction_rule" AS ENUM('reports', 'first_messages', 'same_first_message', 'photo_fetches', 'cards_served', 'round_reads');--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"state" "account_state" DEFAULT 'registered' NOT NULL,
	"state_changed_at" timestamp with time zone,
	"paused_from" "account_state",
	"sanctioned_from" "account_state",
	"birth_year" smallint,
	"birth_month" smallint,
	"gender" "gender",
	"pond_id" uuid,
	"home_place" text,
	"home_shows_area" boolean DEFAULT false NOT NULL,
	"gender_changed_at" timestamp with time zone,
	"email" text,
	"email_confirmed_at" timestamp with time zone,
	"found_them_answered" boolean DEFAULT false NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "account_export" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"role" "moderator_role" NOT NULL,
	"access_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "admin_session_access_hash_unique" UNIQUE("access_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_identity_id" uuid,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"detail" jsonb,
	CONSTRAINT "audit_log_actor_check" CHECK ("audit_log"."actor_identity_id" IS NOT NULL OR "audit_log"."action" = 'sanction.apply')
);
--> statement-breakpoint
CREATE TABLE "auth_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" text NOT NULL,
	"nonce" text NOT NULL,
	"platform" text NOT NULL,
	"locale" text,
	"code_challenge" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"code_used_at" timestamp with time zone,
	"account_id" uuid,
	"outcome" text,
	"identity_id" uuid,
	CONSTRAINT "auth_request_state_unique" UNIQUE("state"),
	CONSTRAINT "auth_request_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blocker_identity_id" uuid NOT NULL,
	"blocked_identity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "block_not_self_check" CHECK ("block"."blocker_identity_id" <> "block"."blocked_identity_id")
);
--> statement-breakpoint
CREATE TABLE "card_shown" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"photo_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "consent_kind" NOT NULL,
	"version" text NOT NULL,
	"locale_shown" text NOT NULL,
	"given_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "contact_kind" NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_value_check" CHECK (length("contact"."value") BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE TABLE "contact_share" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"side" "conversation_side" NOT NULL,
	"kind" "contact_kind" NOT NULL,
	"shared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_how" "contact_share_end",
	CONSTRAINT "contact_share_ended_check" CHECK (("contact_share"."ended_at" IS NULL) = ("contact_share"."ended_how" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone,
	"next_seq" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_how" "conversation_close",
	"closed_by" "conversation_side",
	CONSTRAINT "conversation_closed_check" CHECK (("conversation"."closed_at" IS NULL) = ("conversation"."closed_how" IS NULL)
        AND ("conversation"."closed_at" IS NULL) = ("conversation"."closed_by" IS NULL)),
	CONSTRAINT "conversation_next_seq_check" CHECK ("conversation"."next_seq" >= 1)
);
--> statement-breakpoint
CREATE TABLE "conversation_participant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"account_id" uuid,
	"side" "conversation_side" NOT NULL,
	"read_up_to" integer DEFAULT 0 NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_participant_read_check" CHECK ("conversation_participant"."read_up_to" >= 0)
);
--> statement-breakpoint
CREATE TABLE "email_code" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_code_attempts_check" CHECK ("email_code"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "email_send" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "feedback_kind" NOT NULL,
	"text" text NOT NULL,
	"app_version" text NOT NULL,
	"platform" "feedback_platform" NOT NULL,
	"locale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handled_at" timestamp with time zone,
	"handled_by" uuid
);
--> statement-breakpoint
CREATE TABLE "found_them_count" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"reason" "found_reason" NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "found_them_count_count_check" CHECK ("found_them_count"."count" >= 1)
);
--> statement-breakpoint
CREATE TABLE "identity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hetu_hmac" text NOT NULL,
	"standing" "identity_standing" DEFAULT 'ok' NOT NULL,
	"standing_changed_at" timestamp with time zone,
	"broker_subject" text,
	"broker_session_index" text,
	"broker_token_id" text,
	"authenticated_at" timestamp with time zone,
	"acr" text,
	"amr" text[],
	"deletion_count" integer DEFAULT 0 NOT NULL,
	"reregister_after" timestamp with time zone,
	"refused_attempts" integer DEFAULT 0 NOT NULL,
	"suspension_ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_hetu_hmac_unique" UNIQUE("hetu_hmac")
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inviter_account_id" uuid,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redeemed_by_account_id" uuid,
	"redeemed_at" timestamp with time zone,
	"counted_at" timestamp with time zone,
	CONSTRAINT "invitation_redeemed_check" CHECK (("invitation"."redeemed_at" IS NULL AND "invitation"."redeemed_by_account_id" IS NULL AND "invitation"."counted_at" IS NULL)
          OR ("invitation"."redeemed_at" IS NOT NULL AND ("invitation"."redeemed_by_account_id" IS NOT NULL OR "invitation"."counted_at" IS NOT NULL))),
	CONSTRAINT "invitation_not_self_check" CHECK ("invitation"."redeemed_by_account_id" IS NULL OR "invitation"."redeemed_by_account_id" <> "invitation"."inviter_account_id"),
	CONSTRAINT "invitation_named_check" CHECK ("invitation"."inviter_account_id" IS NOT NULL OR "invitation"."redeemed_by_account_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "matching_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"side" "conversation_side" NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" "message_kind" NOT NULL,
	"body" text,
	"photo_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_text_body_check" CHECK ("message"."kind" <> 'text' OR "message"."body" IS NOT NULL),
	CONSTRAINT "message_seq_check" CHECK ("message"."seq" >= 1),
	CONSTRAINT "message_photo_check" CHECK ("message"."photo_id" IS NULL OR "message"."kind" <> 'text')
);
--> statement-breakpoint
CREATE TABLE "moderator_roles" (
	"identity_id" uuid PRIMARY KEY NOT NULL,
	"role" "moderator_role" NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "notice_kind" NOT NULL,
	"sanction_id" uuid,
	"invitation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notice_warning_check" CHECK (("notice"."kind" = 'warning') = ("notice"."sanction_id" IS NOT NULL)),
	CONSTRAINT "notice_invitation_check" CHECK (("notice"."kind" <> 'warning') = ("notice"."invitation_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "notification_preference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"key" text NOT NULL,
	"blurhash" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"state" "photo_state" DEFAULT 'pending' NOT NULL,
	"rejection_reason" "photo_rejection_reason",
	"appealable" boolean DEFAULT false NOT NULL,
	"purpose" "photo_purpose" DEFAULT 'profile' NOT NULL,
	"position" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"caption" text,
	CONSTRAINT "photo_position_check" CHECK (("photo"."purpose" = 'profile') = ("photo"."position" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "photo_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"photo_id" uuid NOT NULL,
	"variant" "photo_variant" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" "photo_purpose" DEFAULT 'profile' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photo_check_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"photo_id" uuid,
	"kind" "photo_check_kind" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photo_review" (
	"photo_id" uuid PRIMARY KEY NOT NULL,
	"labels" jsonb NOT NULL,
	"faces" integer NOT NULL,
	"flagged" text[] NOT NULL,
	"model_version" text,
	"checked_at" timestamp with time zone,
	"decision" "photo_decision" NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reason" "photo_rejection_reason",
	"appealed_at" timestamp with time zone,
	"description" jsonb
);
--> statement-breakpoint
CREATE TABLE "pond_counter" (
	"pond_id" uuid PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"finished" integer DEFAULT 0 NOT NULL,
	"seeks_men" integer DEFAULT 0 NOT NULL,
	"seeks_everyone" integer DEFAULT 0 NOT NULL,
	"seeks_women" integer DEFAULT 0 NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ponds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name_nominative" text NOT NULL,
	"matching_open" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ponds_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"field" text NOT NULL,
	"value" jsonb NOT NULL,
	"mode" "preference_mode" NOT NULL,
	"include_unknown" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"bio" text,
	"bio_preset" text,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prompts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hidden_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"token" text NOT NULL,
	"platform" "push_platform" NOT NULL,
	"locale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_token_session_id_unique" UNIQUE("session_id"),
	CONSTRAINT "push_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_account_id" uuid NOT NULL,
	"reported_account_id" uuid NOT NULL,
	"source" "report_source" NOT NULL,
	"reason" "sanction_reason" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" "report_outcome",
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"sanction_id" uuid,
	"conversation_id" uuid,
	"line_seq" integer,
	"photo_id" uuid,
	"photo_pointed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "report_not_self_check" CHECK ("report"."reporter_account_id" <> "report"."reported_account_id"),
	CONSTRAINT "report_note_check" CHECK ("report"."note" IS NULL OR char_length("report"."note") BETWEEN 1 AND 500),
	CONSTRAINT "report_decision_check" CHECK (("report"."outcome" IS NULL) = ("report"."decided_at" IS NULL)
        AND ("report"."decided_by" IS NULL) = ("report"."decided_at" IS NULL)
        AND ("report"."sanction_id" IS NULL OR "report"."outcome" = 'acted')),
	CONSTRAINT "report_conversation_check" CHECK ("report"."conversation_id" IS NULL OR "report"."source" <> 'card'),
	CONSTRAINT "report_line_seq_check" CHECK ("report"."line_seq" IS NULL OR ("report"."source" = 'conversation' AND "report"."line_seq" >= 1)),
	CONSTRAINT "report_photo_check" CHECK ((NOT "report"."photo_pointed" OR "report"."source" = 'card')
        AND ("report"."photo_id" IS NULL OR "report"."photo_pointed"))
);
--> statement-breakpoint
CREATE TABLE "report_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"side" "report_message_side" NOT NULL,
	"kind" "message_kind" NOT NULL,
	"body" text,
	"photo_id" uuid,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_subject" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"research_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"consent_version" text NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_subject_research_id_unique" UNIQUE("research_id")
);
--> statement-breakpoint
CREATE TABLE "reward" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "reward_kind" NOT NULL,
	"invitation_id" uuid NOT NULL,
	"earned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"spent_at" timestamp with time zone,
	"spent_entry_id" uuid,
	CONSTRAINT "reward_spent_check" CHECK ("reward"."spent_entry_id" IS NULL OR "reward"."spent_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "round_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"candidate_id" uuid NOT NULL,
	"reason" "round_reason" NOT NULL,
	"seen_at" timestamp with time zone,
	"decision" "round_decision",
	"decided_at" timestamp with time zone,
	"fish" boolean DEFAULT false NOT NULL,
	"second_pass" boolean DEFAULT false NOT NULL,
	"relaxed_field" text,
	"relaxed_with" text[] DEFAULT '{}'::text[] NOT NULL,
	"distance" "distance_band",
	CONSTRAINT "round_entries_position_check" CHECK ("round_entries"."position" >= 1),
	CONSTRAINT "round_entries_decided_check" CHECK (("round_entries"."decision" IS NULL) = ("round_entries"."decided_at" IS NULL)),
	CONSTRAINT "round_entries_fish_check" CHECK (NOT "round_entries"."fish" OR "round_entries"."decision" = 'like'),
	CONSTRAINT "round_entries_second_pass_check" CHECK (NOT "round_entries"."second_pass" OR "round_entries"."decision" = 'pass'),
	CONSTRAINT "round_entries_relaxed_check" CHECK (("round_entries"."reason" = 'relaxed') = ("round_entries"."relaxed_field" IS NOT NULL)
          AND ("round_entries"."relaxed_field" IS NULL OR "round_entries"."relaxed_field" = ANY("round_entries"."relaxed_with")))
);
--> statement-breakpoint
CREATE TABLE "round_relaxation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"field" text NOT NULL,
	"kind" "relaxation_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"day" date NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_position" smallint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sanction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "sanction_kind" NOT NULL,
	"reason" "sanction_reason" NOT NULL,
	"note" text NOT NULL,
	"ends_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" uuid,
	"review_note" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"rule" "sanction_rule",
	"rule_count" integer,
	"rule_first_at" timestamp with time zone,
	CONSTRAINT "sanction_ends_at_check" CHECK (("sanction"."kind" = 'suspend') = ("sanction"."ends_at" IS NOT NULL)),
	CONSTRAINT "sanction_note_check" CHECK (char_length("sanction"."note") BETWEEN 1 AND 500),
	CONSTRAINT "sanction_lift_check" CHECK ("sanction"."lifted_by" IS NULL OR "sanction"."lifted_at" IS NOT NULL),
	CONSTRAINT "sanction_review_check" CHECK (("sanction"."reviewed_at" IS NULL AND "sanction"."reviewed_by" IS NULL AND "sanction"."review_note" IS NULL)
        OR ("sanction"."reviewed_at" IS NOT NULL AND "sanction"."reviewed_by" IS NOT NULL
          AND "sanction"."review_note" IS NOT NULL AND char_length("sanction"."review_note") BETWEEN 1 AND 500)),
	CONSTRAINT "sanction_rule_check" CHECK (("sanction"."rule" IS NULL) = ("sanction"."rule_count" IS NULL)
        AND ("sanction"."rule" IS NULL) = ("sanction"."rule_first_at" IS NULL)
        AND ("sanction"."rule" IS NULL OR ("sanction"."created_by" IS NULL AND "sanction"."kind" = 'shadow_ban'
          AND "sanction"."rule_count" >= 1 AND "sanction"."rule_first_at" <= "sanction"."created_at")))
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"user_agent" text,
	"access_hash" text NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_hash" text NOT NULL,
	"family_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "session_access_hash_unique" UNIQUE("access_hash"),
	CONSTRAINT "session_refresh_hash_unique" UNIQUE("refresh_hash"),
	CONSTRAINT "session_family_hash_unique" UNIQUE("family_hash")
);
--> statement-breakpoint
CREATE TABLE "star" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "star_not_oneself_check" CHECK ("star"."account_id" <> "star"."candidate_id")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_identity_id_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_pond_id_ponds_id_fk" FOREIGN KEY ("pond_id") REFERENCES "public"."ponds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_export" ADD CONSTRAINT "account_export_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_session" ADD CONSTRAINT "admin_session_identity_id_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_identity_id_identity_id_fk" FOREIGN KEY ("actor_identity_id") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_request" ADD CONSTRAINT "auth_request_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_request" ADD CONSTRAINT "auth_request_identity_id_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "block" ADD CONSTRAINT "block_blocker_identity_id_identity_id_fk" FOREIGN KEY ("blocker_identity_id") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "block" ADD CONSTRAINT "block_blocked_identity_id_identity_id_fk" FOREIGN KEY ("blocked_identity_id") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_shown" ADD CONSTRAINT "card_shown_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_shown" ADD CONSTRAINT "card_shown_photo_id_photo_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photo"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT "consent_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_share" ADD CONSTRAINT "contact_share_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participant" ADD CONSTRAINT "conversation_participant_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participant" ADD CONSTRAINT "conversation_participant_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_code" ADD CONSTRAINT "email_code_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_send" ADD CONSTRAINT "email_send_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_handled_by_identity_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_account_id_account_id_fk" FOREIGN KEY ("inviter_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_redeemed_by_account_id_account_id_fk" FOREIGN KEY ("redeemed_by_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_photo_id_photo_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photo"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderator_roles" ADD CONSTRAINT "moderator_roles_identity_id_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_sanction_id_sanction_id_fk" FOREIGN KEY ("sanction_id") REFERENCES "public"."sanction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_invitation_id_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo" ADD CONSTRAINT "photo_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_access" ADD CONSTRAINT "photo_access_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_check_note" ADD CONSTRAINT "photo_check_note_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_check_note" ADD CONSTRAINT "photo_check_note_photo_id_photo_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photo"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_review" ADD CONSTRAINT "photo_review_photo_id_photo_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photo"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_review" ADD CONSTRAINT "photo_review_decided_by_identity_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pond_counter" ADD CONSTRAINT "pond_counter_pond_id_ponds_id_fk" FOREIGN KEY ("pond_id") REFERENCES "public"."ponds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_token" ADD CONSTRAINT "push_token_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_token" ADD CONSTRAINT "push_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_reporter_account_id_account_id_fk" FOREIGN KEY ("reporter_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_reported_account_id_account_id_fk" FOREIGN KEY ("reported_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_decided_by_identity_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_sanction_id_sanction_id_fk" FOREIGN KEY ("sanction_id") REFERENCES "public"."sanction"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_photo_id_photo_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photo"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_message" ADD CONSTRAINT "report_message_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_message" ADD CONSTRAINT "report_message_photo_id_photo_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photo"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_subject" ADD CONSTRAINT "research_subject_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward" ADD CONSTRAINT "reward_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward" ADD CONSTRAINT "reward_invitation_id_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward" ADD CONSTRAINT "reward_spent_entry_id_round_entries_id_fk" FOREIGN KEY ("spent_entry_id") REFERENCES "public"."round_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_candidate_id_account_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_relaxation" ADD CONSTRAINT "round_relaxation_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sanction" ADD CONSTRAINT "sanction_identity_id_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sanction" ADD CONSTRAINT "sanction_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sanction" ADD CONSTRAINT "sanction_created_by_identity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sanction" ADD CONSTRAINT "sanction_lifted_by_identity_id_fk" FOREIGN KEY ("lifted_by") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sanction" ADD CONSTRAINT "sanction_reviewed_by_identity_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "star" ADD CONSTRAINT "star_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "star" ADD CONSTRAINT "star_candidate_id_account_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_one_live_per_identity_idx" ON "account" USING btree ("identity_id") WHERE "account"."state" <> 'deleted';--> statement-breakpoint
CREATE INDEX "account_state_idx" ON "account" USING btree ("state");--> statement-breakpoint
CREATE INDEX "account_export_account_at_idx" ON "account_export" USING btree ("account_id","at");--> statement-breakpoint
CREATE INDEX "admin_session_identity_idx" ON "admin_session" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "audit_log_subject_idx" ON "audit_log" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_at_idx" ON "audit_log" USING btree ("actor_identity_id","at");--> statement-breakpoint
CREATE INDEX "auth_request_expires_at_idx" ON "auth_request" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "block_pair_idx" ON "block" USING btree ("blocker_identity_id","blocked_identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "card_shown_account_photo_idx" ON "card_shown" USING btree ("account_id","photo_id");--> statement-breakpoint
CREATE INDEX "card_shown_photo_idx" ON "card_shown" USING btree ("photo_id");--> statement-breakpoint
CREATE INDEX "consent_account_kind_idx" ON "consent" USING btree ("account_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_account_kind_idx" ON "contact" USING btree ("account_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_share_standing_idx" ON "contact_share" USING btree ("conversation_id","side","kind") WHERE "contact_share"."ended_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_participant_side_idx" ON "conversation_participant" USING btree ("conversation_id","side");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_participant_account_idx" ON "conversation_participant" USING btree ("conversation_id","account_id");--> statement-breakpoint
CREATE INDEX "conversation_participant_account_id_idx" ON "conversation_participant" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "email_send_account_at_idx" ON "email_send" USING btree ("account_id","at");--> statement-breakpoint
CREATE INDEX "feedback_account_created_idx" ON "feedback" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_handled_created_idx" ON "feedback" USING btree ("handled_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "found_them_count_day_reason_idx" ON "found_them_count" USING btree ("day","reason");--> statement-breakpoint
CREATE INDEX "identity_standing_idx" ON "identity" USING btree ("standing");--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_code_hash_idx" ON "invitation" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "invitation_inviter_created_idx" ON "invitation" USING btree ("inviter_account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_redeemed_by_idx" ON "invitation" USING btree ("redeemed_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "matching_config_key_version_idx" ON "matching_config" USING btree ("key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "message_seq_idx" ON "message" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "message_client_idx" ON "message" USING btree ("conversation_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_photo_idx" ON "message" USING btree ("photo_id");--> statement-breakpoint
CREATE INDEX "notice_account_created_idx" ON "notice" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preference_kind_idx" ON "notification_preference" USING btree ("account_id","kind");--> statement-breakpoint
CREATE INDEX "photo_account_position_idx" ON "photo" USING btree ("account_id","position");--> statement-breakpoint
CREATE INDEX "photo_key_idx" ON "photo" USING btree ("key");--> statement-breakpoint
CREATE INDEX "photo_message_day_idx" ON "photo" USING btree ("account_id","created_at") WHERE "photo"."purpose" = 'message';--> statement-breakpoint
CREATE INDEX "photo_access_account_at_idx" ON "photo_access" USING btree ("account_id","at");--> statement-breakpoint
CREATE INDEX "photo_check_note_account_at_idx" ON "photo_check_note" USING btree ("account_id","at");--> statement-breakpoint
CREATE INDEX "photo_review_decision_idx" ON "photo_review" USING btree ("decision","checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "preferences_account_field_idx" ON "preferences" USING btree ("account_id","field");--> statement-breakpoint
CREATE INDEX "push_token_account_idx" ON "push_token" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "report_reporter_created_idx" ON "report" USING btree ("reporter_account_id","created_at");--> statement-breakpoint
CREATE INDEX "report_reported_created_idx" ON "report" USING btree ("reported_account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "report_open_pair_idx" ON "report" USING btree ("reporter_account_id","reported_account_id") WHERE "report"."decided_at" IS NULL;--> statement-breakpoint
CREATE INDEX "report_photo_idx" ON "report" USING btree ("photo_id") WHERE "report"."photo_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "report_message_seq_idx" ON "report_message" USING btree ("report_id","seq");--> statement-breakpoint
CREATE INDEX "report_message_photo_idx" ON "report_message" USING btree ("photo_id") WHERE "report_message"."photo_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "reward_account_kind_idx" ON "reward" USING btree ("account_id","kind");--> statement-breakpoint
CREATE INDEX "reward_invitation_idx" ON "reward" USING btree ("invitation_id");--> statement-breakpoint
CREATE INDEX "reward_spent_entry_idx" ON "reward" USING btree ("spent_entry_id") WHERE "reward"."spent_entry_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "round_entries_round_position_idx" ON "round_entries" USING btree ("round_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "round_entries_candidate_round_idx" ON "round_entries" USING btree ("candidate_id","round_id");--> statement-breakpoint
CREATE UNIQUE INDEX "round_relaxation_round_field_idx" ON "round_relaxation" USING btree ("round_id","field");--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_account_day_idx" ON "rounds" USING btree ("account_id","day");--> statement-breakpoint
CREATE INDEX "sanction_account_created_idx" ON "sanction" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "sanction_identity_open_idx" ON "sanction" USING btree ("identity_id") WHERE "sanction"."lifted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "session_account_idx" ON "session" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "star_account_candidate_idx" ON "star" USING btree ("account_id","candidate_id");--> statement-breakpoint
CREATE INDEX "star_candidate_idx" ON "star" USING btree ("candidate_id");