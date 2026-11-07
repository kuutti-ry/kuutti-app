ALTER TYPE "public"."notice_kind" ADD VALUE 'announcement';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'announcement';--> statement-breakpoint
CREATE TABLE "announcement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title_en" text NOT NULL,
	"body_en" text NOT NULL,
	"title_fi" text NOT NULL,
	"body_fi" text NOT NULL,
	"title_sv" text,
	"body_sv" text,
	"written_by" uuid NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	CONSTRAINT "announcement_swedish_check" CHECK (("announcement"."title_sv" IS NULL) = ("announcement"."body_sv" IS NULL)),
	CONSTRAINT "announcement_approval_check" CHECK (("announcement"."approved_by" IS NULL) = ("announcement"."approved_at" IS NULL)),
	CONSTRAINT "announcement_second_admin_check" CHECK ("announcement"."approved_by" <> "announcement"."written_by")
);
--> statement-breakpoint
ALTER TABLE "notice" DROP CONSTRAINT "notice_invitation_check";--> statement-breakpoint
ALTER TABLE "notice" ADD COLUMN "announcement_id" uuid;--> statement-breakpoint
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_written_by_identity_id_fk" FOREIGN KEY ("written_by") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_approved_by_identity_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcement_written_idx" ON "announcement" USING btree ("written_at");--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_announcement_id_announcement_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notice_announcement_idx" ON "notice" USING btree ("announcement_id") WHERE "notice"."announcement_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_announcement_check" CHECK (("notice"."kind" NOT IN ('warning', 'invitation_counted', 'invitation_friend')) = ("notice"."announcement_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_invitation_check" CHECK (("notice"."kind" IN ('invitation_counted', 'invitation_friend')) = ("notice"."invitation_id" IS NOT NULL));