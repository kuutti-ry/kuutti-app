CREATE TABLE "star" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "star_not_oneself_check" CHECK ("star"."account_id" <> "star"."candidate_id")
);
--> statement-breakpoint
ALTER TABLE "star" ADD CONSTRAINT "star_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "star" ADD CONSTRAINT "star_candidate_id_account_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "star_account_candidate_idx" ON "star" USING btree ("account_id","candidate_id");--> statement-breakpoint
CREATE INDEX "star_candidate_idx" ON "star" USING btree ("candidate_id");