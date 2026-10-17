CREATE TYPE "public"."conversation_close" AS ENUM('block', 'unmatch', 'erasure', 'sanction');--> statement-breakpoint
CREATE TYPE "public"."conversation_side" AS ENUM('a', 'b');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('text');--> statement-breakpoint
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
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"side" "conversation_side" NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" "message_kind" NOT NULL,
	"body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_text_body_check" CHECK ("message"."kind" <> 'text' OR "message"."body" IS NOT NULL),
	CONSTRAINT "message_seq_check" CHECK ("message"."seq" >= 1)
);
--> statement-breakpoint
ALTER TABLE "conversation_participant" ADD CONSTRAINT "conversation_participant_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participant" ADD CONSTRAINT "conversation_participant_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_participant_side_idx" ON "conversation_participant" USING btree ("conversation_id","side");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_participant_account_idx" ON "conversation_participant" USING btree ("conversation_id","account_id");--> statement-breakpoint
CREATE INDEX "conversation_participant_account_id_idx" ON "conversation_participant" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_seq_idx" ON "message" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "message_client_idx" ON "message" USING btree ("conversation_id","client_id");