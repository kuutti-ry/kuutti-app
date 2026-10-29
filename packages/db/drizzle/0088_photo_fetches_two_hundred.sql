-- Custom SQL migration file, put your code below! ---- A new version of auto_shadow_ban_photo_fetches (#513, ADR-041 History
-- 2026-10-29): 200 card-size URLs of other people's photos within the 60
-- minutes, the maintainer's of 29/10/2026, where version 1 (migration 0075)
-- took 120. A card now shows each of its photos in the card size as it comes
-- to the front, and a full round (round_size, liked_you_cap, the fish places,
-- max_photos) looked at whole within the hour reached 120. Written as the
-- next version of the key, as 0069 writes round_size, so a value set in the
-- panel before this ran (#305) is followed, not kept; on a database with only
-- version 1 it is version 2, the row the seed writes too
-- (packages/db/src/seed.ts; migrate.test.ts keeps the two identical). The
-- migration names itself in created_by and gives no reason, as every version
-- a migration writes; this comment and ADR-041 say why.
INSERT INTO "matching_config" ("version", "key", "value", "created_by")
SELECT coalesce(max("version"), 0) + 1, 'auto_shadow_ban_photo_fetches', '200'::jsonb, 'migration:0088'
  FROM "matching_config" WHERE "key" = 'auto_shadow_ban_photo_fetches';
