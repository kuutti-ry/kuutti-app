CREATE TYPE "public"."contact_kind" AS ENUM('phone', 'whatsapp', 'telegram', 'instagram');--> statement-breakpoint
CREATE TYPE "public"."contact_share_end" AS ENUM('stopped', 'removed', 'closed');--> statement-breakpoint
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
ALTER TABLE "contact" ADD CONSTRAINT "contact_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_share" ADD CONSTRAINT "contact_share_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_account_kind_idx" ON "contact" USING btree ("account_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_share_standing_idx" ON "contact_share" USING btree ("conversation_id","side","kind") WHERE "contact_share"."ended_at" IS NULL;