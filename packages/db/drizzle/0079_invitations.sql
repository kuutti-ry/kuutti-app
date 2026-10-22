CREATE TYPE "public"."reward_kind" AS ENUM('like', 'fish');--> statement-breakpoint
ALTER TYPE "public"."notice_kind" ADD VALUE 'invitation_counted';--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inviter_account_id" uuid,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redeemed_by_account_id" uuid,
	"redeemed_at" timestamp with time zone,
	"counted_at" timestamp with time zone,
	CONSTRAINT "invitation_redeemed_check" CHECK (("invitation"."redeemed_at" IS NULL AND "invitation"."redeemed_by_account_id" IS NULL AND "invitation"."counted_at" IS NULL)
          OR ("invitation"."redeemed_at" IS NOT NULL AND ("invitation"."redeemed_by_account_id" IS NOT NULL OR "invitation"."counted_at" IS NOT NULL))),
	CONSTRAINT "invitation_not_self_check" CHECK ("invitation"."redeemed_by_account_id" IS NULL OR "invitation"."redeemed_by_account_id" <> "invitation"."inviter_account_id"),
	CONSTRAINT "invitation_named_check" CHECK ("invitation"."inviter_account_id" IS NOT NULL OR "invitation"."redeemed_by_account_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "reward" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "reward_kind" NOT NULL,
	"invitation_id" uuid NOT NULL,
	"earned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"spent_at" timestamp with time zone,
	"spent_entry_id" uuid,
	CONSTRAINT "reward_spent_check" CHECK ("reward"."spent_entry_id" IS NULL OR "reward"."spent_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "notice" ADD COLUMN "invitation_id" uuid;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_account_id_account_id_fk" FOREIGN KEY ("inviter_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_redeemed_by_account_id_account_id_fk" FOREIGN KEY ("redeemed_by_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward" ADD CONSTRAINT "reward_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward" ADD CONSTRAINT "reward_invitation_id_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward" ADD CONSTRAINT "reward_spent_entry_id_round_entries_id_fk" FOREIGN KEY ("spent_entry_id") REFERENCES "public"."round_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_code_hash_idx" ON "invitation" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "invitation_inviter_created_idx" ON "invitation" USING btree ("inviter_account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_redeemed_by_idx" ON "invitation" USING btree ("redeemed_by_account_id");--> statement-breakpoint
CREATE INDEX "reward_account_kind_idx" ON "reward" USING btree ("account_id","kind");--> statement-breakpoint
CREATE INDEX "reward_invitation_idx" ON "reward" USING btree ("invitation_id");--> statement-breakpoint
CREATE INDEX "reward_spent_entry_idx" ON "reward" USING btree ("spent_entry_id") WHERE "reward"."spent_entry_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_invitation_id_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_invitation_check" CHECK (("notice"."kind" <> 'warning') = ("notice"."invitation_id" IS NOT NULL));