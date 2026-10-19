CREATE TYPE "public"."sanction_rule" AS ENUM('reports', 'first_messages', 'same_first_message');--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "actor_identity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sanction" ADD COLUMN "rule" "sanction_rule";--> statement-breakpoint
ALTER TABLE "sanction" ADD COLUMN "rule_count" integer;--> statement-breakpoint
ALTER TABLE "sanction" ADD COLUMN "rule_first_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "report_reported_created_idx" ON "report" USING btree ("reported_account_id","created_at");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_check" CHECK ("audit_log"."actor_identity_id" IS NOT NULL OR "audit_log"."action" = 'sanction.apply');--> statement-breakpoint
ALTER TABLE "sanction" ADD CONSTRAINT "sanction_rule_check" CHECK (("sanction"."rule" IS NULL) = ("sanction"."rule_count" IS NULL)
        AND ("sanction"."rule" IS NULL) = ("sanction"."rule_first_at" IS NULL)
        AND ("sanction"."rule" IS NULL OR ("sanction"."created_by" IS NULL AND "sanction"."kind" = 'shadow_ban'
          AND "sanction"."rule_count" >= 1 AND "sanction"."rule_first_at" <= "sanction"."created_at")));