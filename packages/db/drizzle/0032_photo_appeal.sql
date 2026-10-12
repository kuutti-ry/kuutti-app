ALTER TABLE "photo" ADD COLUMN "appealable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "photo_review" ADD COLUMN "appealed_at" timestamp with time zone;