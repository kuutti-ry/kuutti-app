CREATE TYPE "public"."report_outcome" AS ENUM('dismissed', 'acted');--> statement-breakpoint
CREATE TYPE "public"."report_source" AS ENUM('card');--> statement-breakpoint
CREATE TABLE "block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blocker_identity_id" uuid NOT NULL,
	"blocked_identity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "block_not_self_check" CHECK ("block"."blocker_identity_id" <> "block"."blocked_identity_id")
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
	CONSTRAINT "report_not_self_check" CHECK ("report"."reporter_account_id" <> "report"."reported_account_id"),
	CONSTRAINT "report_note_check" CHECK ("report"."note" IS NULL OR char_length("report"."note") BETWEEN 1 AND 500),
	CONSTRAINT "report_decision_check" CHECK (("report"."outcome" IS NULL) = ("report"."decided_at" IS NULL)
        AND ("report"."decided_by" IS NULL) = ("report"."decided_at" IS NULL)
        AND ("report"."sanction_id" IS NULL OR "report"."outcome" = 'acted'))
);
--> statement-breakpoint
ALTER TABLE "block" ADD CONSTRAINT "block_blocker_identity_id_identity_id_fk" FOREIGN KEY ("blocker_identity_id") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "block" ADD CONSTRAINT "block_blocked_identity_id_identity_id_fk" FOREIGN KEY ("blocked_identity_id") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_reporter_account_id_account_id_fk" FOREIGN KEY ("reporter_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_reported_account_id_account_id_fk" FOREIGN KEY ("reported_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_decided_by_identity_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_sanction_id_sanction_id_fk" FOREIGN KEY ("sanction_id") REFERENCES "public"."sanction"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "block_pair_idx" ON "block" USING btree ("blocker_identity_id","blocked_identity_id");--> statement-breakpoint
CREATE INDEX "report_reporter_created_idx" ON "report" USING btree ("reporter_account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "report_open_pair_idx" ON "report" USING btree ("reporter_account_id","reported_account_id") WHERE "report"."decided_at" IS NULL;