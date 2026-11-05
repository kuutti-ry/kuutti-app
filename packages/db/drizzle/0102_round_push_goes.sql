-- Custom SQL migration file, put your code below! --
-- The round's push goes (#502, ADR-062 §12, the maintainer's word of
-- 01/11/2026): nothing is built at night, so nothing is ready at nine. Its two
-- keys go whole, every version of each (rules/db.md), and so do the switches
-- people left on it, before the next migration takes `round` out of
-- notification_kind, which a row still naming it would refuse. The seed has
-- dropped both keys too, so no re-seed writes them back.
DELETE FROM "matching_config" WHERE "key" IN ('round_push_hour', 'round_push_idle_days');--> statement-breakpoint
DELETE FROM "notification_preference" WHERE "kind" = 'round';
