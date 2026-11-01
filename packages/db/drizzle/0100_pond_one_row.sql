ALTER TABLE "ponds" DROP CONSTRAINT "ponds_parent_id_ponds_id_fk";
--> statement-breakpoint
ALTER TABLE "ponds" DROP COLUMN "name_inessive";--> statement-breakpoint
ALTER TABLE "ponds" DROP COLUMN "parent_id";