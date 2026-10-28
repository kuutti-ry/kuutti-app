DROP INDEX "session_retired_refresh_hash_idx";--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "family_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "session" DROP COLUMN "retired_refresh_hash";--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_family_hash_unique" UNIQUE("family_hash");