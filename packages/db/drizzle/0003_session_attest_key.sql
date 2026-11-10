ALTER TABLE "session" ADD COLUMN "attest_key" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "attest_counter" bigint;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_attest_key_unique" UNIQUE("attest_key");--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_attest_check" CHECK (("session"."attest_key" IS NULL) = ("session"."attest_counter" IS NULL) AND "session"."attest_counter" >= 0);