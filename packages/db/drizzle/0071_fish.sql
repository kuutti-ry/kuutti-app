ALTER TYPE "public"."round_reason" ADD VALUE 'fish';--> statement-breakpoint
ALTER TABLE "round_entries" ADD COLUMN "fish" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_fish_check" CHECK (NOT "round_entries"."fish" OR "round_entries"."decision" = 'like');