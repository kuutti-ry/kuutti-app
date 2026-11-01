ALTER TABLE "waitlist_snapshot" RENAME TO "pond_counter";--> statement-breakpoint
ALTER TABLE "pond_counter" DROP CONSTRAINT "waitlist_snapshot_pond_id_ponds_id_fk";
--> statement-breakpoint
ALTER TABLE "pond_counter" ADD CONSTRAINT "pond_counter_pond_id_ponds_id_fk" FOREIGN KEY ("pond_id") REFERENCES "public"."ponds"("id") ON DELETE no action ON UPDATE no action;