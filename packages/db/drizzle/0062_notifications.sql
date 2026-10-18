CREATE TYPE "public"."notice_kind" AS ENUM('warning');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('round', 'message', 'match', 'moderation');--> statement-breakpoint
CREATE TABLE "notice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "notice_kind" NOT NULL,
	"sanction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notice_warning_check" CHECK (("notice"."kind" = 'warning') = ("notice"."sanction_id" IS NOT NULL))
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
ALTER TABLE "notice" ADD CONSTRAINT "notice_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_sanction_id_sanction_id_fk" FOREIGN KEY ("sanction_id") REFERENCES "public"."sanction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notice_account_created_idx" ON "notice" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preference_kind_idx" ON "notification_preference" USING btree ("account_id","kind");