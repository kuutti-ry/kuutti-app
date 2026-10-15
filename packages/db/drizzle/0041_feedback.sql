CREATE TYPE "public"."feedback_kind" AS ENUM('bug', 'idea', 'complaint', 'praise');--> statement-breakpoint
CREATE TYPE "public"."feedback_platform" AS ENUM('ios', 'android', 'web');--> statement-breakpoint
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
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_handled_by_identity_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_account_created_idx" ON "feedback" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_handled_created_idx" ON "feedback" USING btree ("handled_at","created_at");