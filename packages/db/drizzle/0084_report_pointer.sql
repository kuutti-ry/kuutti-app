ALTER TABLE "report" ADD COLUMN "line_seq" integer;--> statement-breakpoint
ALTER TABLE "report" ADD COLUMN "photo_id" uuid;--> statement-breakpoint
ALTER TABLE "report" ADD COLUMN "photo_pointed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_photo_id_photo_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photo"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_photo_idx" ON "report" USING btree ("photo_id") WHERE "report"."photo_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_line_seq_check" CHECK ("report"."line_seq" IS NULL OR ("report"."source" = 'conversation' AND "report"."line_seq" >= 1));--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_photo_check" CHECK ((NOT "report"."photo_pointed" OR "report"."source" = 'card')
        AND ("report"."photo_id" IS NULL OR "report"."photo_pointed"));