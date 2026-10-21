CREATE TYPE "public"."found_reason" AS ENUM('here', 'elsewhere', 'other');--> statement-breakpoint
CREATE TABLE "found_them_count" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"reason" "found_reason" NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "found_them_count_count_check" CHECK ("found_them_count"."count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "found_them_answered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "found_them_count_day_reason_idx" ON "found_them_count" USING btree ("day","reason");