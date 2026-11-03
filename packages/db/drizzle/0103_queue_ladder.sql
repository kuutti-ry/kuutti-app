ALTER TYPE "public"."round_decision" ADD VALUE 'skip';--> statement-breakpoint
ALTER TABLE "notification_preference" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."notification_kind";--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('message', 'match', 'moderation');--> statement-breakpoint
ALTER TABLE "notification_preference" ALTER COLUMN "kind" SET DATA TYPE "public"."notification_kind" USING "kind"::"public"."notification_kind";--> statement-breakpoint
ALTER TABLE "round_entries" ADD COLUMN "second_pass" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "home_moved_at";--> statement-breakpoint
ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_second_pass_check" CHECK (NOT "round_entries"."second_pass" OR "round_entries"."decision" = 'pass');