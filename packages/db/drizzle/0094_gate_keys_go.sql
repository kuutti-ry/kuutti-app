-- Custom SQL migration file, put your code below! --
-- The gate's two keys go with it (#500, ADR-060 §6): nothing reads gate_k or
-- majority_share_max any more, and a key that stays would look like a rule
-- that still holds. Whole keys, every version of each: a version of a key that
-- lives is never deleted or rewritten (rules/db.md). change_cadence_days stays,
-- a limit on gender alone (ADR-060 §9). The seed has dropped both keys too, so
-- no re-seed writes them back (packages/db/src/seed.ts; migrate.test.ts keeps
-- the two identical).
DELETE FROM "matching_config" WHERE "key" IN ('gate_k', 'majority_share_max');
