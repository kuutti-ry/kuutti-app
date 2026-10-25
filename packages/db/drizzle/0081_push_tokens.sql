CREATE TYPE "public"."push_platform" AS ENUM('ios', 'android');--> statement-breakpoint
CREATE TABLE "push_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"token" text NOT NULL,
	"platform" "push_platform" NOT NULL,
	"locale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_token_session_id_unique" UNIQUE("session_id"),
	CONSTRAINT "push_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "push_token" ADD CONSTRAINT "push_token_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_token" ADD CONSTRAINT "push_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_token_account_idx" ON "push_token" USING btree ("account_id");