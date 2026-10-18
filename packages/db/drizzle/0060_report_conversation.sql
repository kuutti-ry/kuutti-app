CREATE TYPE "public"."report_message_side" AS ENUM('reporter', 'reported');--> statement-breakpoint
ALTER TYPE "public"."report_source" ADD VALUE 'conversation';--> statement-breakpoint
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
ALTER TABLE "report" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "report_message" ADD CONSTRAINT "report_message_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_message" ADD CONSTRAINT "report_message_photo_id_photo_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photo"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_message_seq_idx" ON "report_message" USING btree ("report_id","seq");--> statement-breakpoint
CREATE INDEX "report_message_photo_idx" ON "report_message" USING btree ("photo_id") WHERE "report_message"."photo_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_conversation_check" CHECK ("report"."conversation_id" IS NULL OR "report"."source" <> 'card');