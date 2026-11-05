ALTER TYPE "public"."notice_kind" ADD VALUE 'invitation_friend';--> statement-breakpoint
ALTER TABLE "reward" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."reward_kind";--> statement-breakpoint
CREATE TYPE "public"."reward_kind" AS ENUM('fish');--> statement-breakpoint
ALTER TABLE "reward" ALTER COLUMN "kind" SET DATA TYPE "public"."reward_kind" USING "kind"::"public"."reward_kind";