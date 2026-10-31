DROP TABLE "gate" CASCADE;--> statement-breakpoint
ALTER TABLE "ponds" ADD COLUMN "matching_open" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "seeks_changed_at";