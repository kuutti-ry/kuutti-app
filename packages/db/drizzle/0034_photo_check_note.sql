CREATE TYPE "public"."photo_check_kind" AS ENUM('nudity', 'violence', 'disturbing', 'hate');--> statement-breakpoint
CREATE TABLE "photo_check_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"photo_id" uuid,
	"kind" "photo_check_kind" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "photo_check_note" ADD CONSTRAINT "photo_check_note_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_check_note" ADD CONSTRAINT "photo_check_note_photo_id_photo_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photo"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "photo_check_note_account_at_idx" ON "photo_check_note" USING btree ("account_id","at");