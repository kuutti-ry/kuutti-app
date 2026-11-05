ALTER TABLE "pond_counter" ADD COLUMN "finished" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pond_counter" DROP COLUMN "verified";--> statement-breakpoint
ALTER TABLE "pond_counter" DROP COLUMN "woman";--> statement-breakpoint
ALTER TABLE "pond_counter" DROP COLUMN "man";--> statement-breakpoint
ALTER TABLE "pond_counter" DROP COLUMN "non_binary";--> statement-breakpoint
ALTER TABLE "pond_counter" DROP COLUMN "finishing";