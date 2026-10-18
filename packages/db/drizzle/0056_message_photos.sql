CREATE TYPE "public"."photo_purpose" AS ENUM('profile', 'message');--> statement-breakpoint
ALTER TYPE "public"."message_kind" ADD VALUE 'photo';--> statement-breakpoint
ALTER TABLE "photo" ALTER COLUMN "position" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "photo_id" uuid;--> statement-breakpoint
ALTER TABLE "photo" ADD COLUMN "purpose" "photo_purpose" DEFAULT 'profile' NOT NULL;--> statement-breakpoint
ALTER TABLE "photo_access" ADD COLUMN "purpose" "photo_purpose" DEFAULT 'profile' NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_photo_id_photo_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photo"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_photo_idx" ON "message" USING btree ("photo_id");--> statement-breakpoint
CREATE INDEX "photo_message_day_idx" ON "photo" USING btree ("account_id","created_at") WHERE "photo"."purpose" = 'message';--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_photo_check" CHECK ("message"."photo_id" IS NULL OR "message"."kind" <> 'text');--> statement-breakpoint
ALTER TABLE "photo" ADD CONSTRAINT "photo_position_check" CHECK (("photo"."purpose" = 'profile') = ("photo"."position" IS NOT NULL));