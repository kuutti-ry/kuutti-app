CREATE TYPE "public"."round_decision" AS ENUM('like', 'pass');--> statement-breakpoint
CREATE TYPE "public"."round_reason" AS ENUM('matches_filters', 'liked_you', 'seen_before', 'relaxed');--> statement-breakpoint
CREATE TABLE "round_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"candidate_id" uuid NOT NULL,
	"reason" "round_reason" NOT NULL,
	"seen_at" timestamp with time zone,
	"decision" "round_decision",
	"decided_at" timestamp with time zone,
	CONSTRAINT "round_entries_position_check" CHECK ("round_entries"."position" >= 1),
	CONSTRAINT "round_entries_decided_check" CHECK (("round_entries"."decision" IS NULL) = ("round_entries"."decided_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"day" date NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_candidate_id_account_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "round_entries_round_position_idx" ON "round_entries" USING btree ("round_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "round_entries_candidate_round_idx" ON "round_entries" USING btree ("candidate_id","round_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_account_day_idx" ON "rounds" USING btree ("account_id","day");