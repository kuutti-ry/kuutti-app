-- Custom SQL migration file, put your code below! --
-- One pond (#514, ADR-061 §8): "pond is not relevant anymore", the maintainer's
-- of 31/10/2026, read as one country-wide pool, in which a person's home says
-- where they are. `suomi` survives, being the one row every database has
-- (0027); the capital region comes from the seed alone, so a database may have
-- it, have children under it (ADR-010 §11), or have neither. Matching stays as
-- open as it was: `suomi` opens where any pond was open, so that nobody loses
-- it, and a database with every pond closed stays closed (ADR-060 §1). Accounts
-- move to `suomi` as they stand; a NULL pond stays NULL, a tombstone's among
-- them. Every row of the figures goes, `suomi`'s too: it stands on a smaller
-- pond, and `moveFigures` would hold it until k people moved; the boot counts
-- afresh on an empty table. The other ponds go in one statement, so that a
-- child and its parent go together, however deep the tree. `events` keeps the
-- slugs it has: they are text, append-only, and age out. default_pond is
-- written as the next version of the key, as 0069 writes round_size, so that a
-- value set in the panel before this ran (#305) is followed, not kept; on a
-- database with two versions it is version 3, the row the seed writes too
-- (packages/db/src/seed.ts; migrate.test.ts keeps the two identical). The lock
-- holds to the end of the migrations' one transaction, so the container still
-- running the old code cannot name a pond in between; it waits, and fails once
-- the row is gone.
LOCK TABLE "ponds" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
UPDATE "ponds" SET "matching_open" = true
  WHERE "slug" = 'suomi' AND EXISTS (SELECT 1 FROM "ponds" p WHERE p."matching_open");--> statement-breakpoint
UPDATE "account" SET "pond_id" = s."id" FROM "ponds" s
  WHERE s."slug" = 'suomi' AND "account"."pond_id" <> s."id";--> statement-breakpoint
DELETE FROM "waitlist_snapshot";--> statement-breakpoint
DELETE FROM "ponds" WHERE "slug" <> 'suomi';--> statement-breakpoint
INSERT INTO "matching_config" ("version", "key", "value", "created_by")
SELECT coalesce(max("version"), 0) + 1, 'default_pond', '"suomi"'::jsonb, 'migration:0095'
  FROM "matching_config" WHERE "key" = 'default_pond';
