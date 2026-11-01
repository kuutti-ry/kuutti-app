-- Custom SQL migration file, put your code below! --
-- default_pond goes (#500, ADR-061 History, the maintainer's word of
-- 01/11/2026): with one pond a default chooses nothing, and a slug no row has,
-- saved in the panel, would have stopped every newcomer at the home step. The
-- write of a home names the one row itself. The whole key, every version of it:
-- a version of a key that lives is never deleted or rewritten (rules/db.md).
-- The seed has dropped it too, so no re-seed writes it back
-- (packages/db/src/seed.ts; migrate.test.ts keeps the two identical).
DELETE FROM "matching_config" WHERE "key" = 'default_pond';
