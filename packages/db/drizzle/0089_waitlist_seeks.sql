ALTER TABLE "waitlist_snapshot" ADD COLUMN "seeks_men" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "waitlist_snapshot" ADD COLUMN "seeks_everyone" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "waitlist_snapshot" ADD COLUMN "seeks_women" integer DEFAULT 0 NOT NULL;