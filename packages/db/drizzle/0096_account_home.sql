CREATE TYPE "public"."distance_band" AS ENUM('nearby', 'close', 'around', 'far');--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "home_place" text;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "home_shows_area" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "home_moved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "round_entries" ADD COLUMN "distance" "distance_band";