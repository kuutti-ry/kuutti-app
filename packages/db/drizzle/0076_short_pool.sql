CREATE TYPE "public"."relaxation_kind" AS ENUM('unanswered', 'aside');--> statement-breakpoint
CREATE TABLE "round_relaxation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"field" text NOT NULL,
	"kind" "relaxation_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "round_entries" ADD COLUMN "relaxed_field" text;--> statement-breakpoint
ALTER TABLE "round_entries" ADD COLUMN "relaxed_with" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "last_position" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "round_relaxation" ADD CONSTRAINT "round_relaxation_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "round_relaxation_round_field_idx" ON "round_relaxation" USING btree ("round_id","field");--> statement-breakpoint
ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_relaxed_check" CHECK (("round_entries"."reason" = 'relaxed') = ("round_entries"."relaxed_field" IS NOT NULL)
          AND ("round_entries"."relaxed_field" IS NULL OR "round_entries"."relaxed_field" = ANY("round_entries"."relaxed_with")));