-- Custom SQL migration file, put your code below! --
-- The counter's k takes the counter's name (#500, ADR-013 §17): nobody waits at
-- a pond any more, so no key says so. Every version of the key moves, each with
-- its value, its number and who wrote it, so an admin's raised k stays in force
-- and the history reads whole; a key renamed moves whole (rules/db.md). The
-- seed writes the new name too (packages/db/src/seed.ts; migrate.test.ts keeps
-- the two identical).
UPDATE "matching_config" SET "key" = 'pond_counter_k' WHERE "key" = 'waitlist_k';
-- A table renamed keeps its primary key's name, which the schema DSL does not
-- see and 0095 could not move.
ALTER TABLE "pond_counter" RENAME CONSTRAINT "waitlist_snapshot_pkey" TO "pond_counter_pkey";
