CREATE TYPE "public"."sanction_kind" AS ENUM('warn', 'shadow_ban', 'suspend', 'ban');--> statement-breakpoint
CREATE TYPE "public"."sanction_reason" AS ENUM('harassment', 'misrepresentation', 'under_age', 'commercial_use', 'scraping', 'other');--> statement-breakpoint
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
	CONSTRAINT "sanction_ends_at_check" CHECK (("sanction"."kind" = 'suspend') = ("sanction"."ends_at" IS NOT NULL)),
	CONSTRAINT "sanction_note_check" CHECK (char_length("sanction"."note") BETWEEN 1 AND 500),
	CONSTRAINT "sanction_lift_check" CHECK ("sanction"."lifted_by" IS NULL OR "sanction"."lifted_at" IS NOT NULL),
	CONSTRAINT "sanction_review_check" CHECK (("sanction"."reviewed_at" IS NULL AND "sanction"."reviewed_by" IS NULL AND "sanction"."review_note" IS NULL)
        OR ("sanction"."reviewed_at" IS NOT NULL AND "sanction"."reviewed_by" IS NOT NULL
          AND "sanction"."review_note" IS NOT NULL AND char_length("sanction"."review_note") BETWEEN 1 AND 500))
);
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "sanctioned_from" "account_state";--> statement-breakpoint
ALTER TABLE "identity" ADD COLUMN "suspension_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sanction" ADD CONSTRAINT "sanction_identity_id_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sanction" ADD CONSTRAINT "sanction_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sanction" ADD CONSTRAINT "sanction_created_by_identity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sanction" ADD CONSTRAINT "sanction_lifted_by_identity_id_fk" FOREIGN KEY ("lifted_by") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sanction" ADD CONSTRAINT "sanction_reviewed_by_identity_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sanction_account_created_idx" ON "sanction" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "sanction_identity_open_idx" ON "sanction" USING btree ("identity_id") WHERE "sanction"."lifted_at" IS NULL;