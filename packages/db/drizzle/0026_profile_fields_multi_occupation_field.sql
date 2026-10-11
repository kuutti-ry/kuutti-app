-- Custom SQL migration file, put your code below! --
-- A person can have several lines of work and several fields (#178, ADR-019 §1
-- amended 10/10/2026): the registry's `occupation` and `field` are multi-choice
-- now, up to three each. A stored single answer becomes a one-element array so
-- that nobody's answer is read as unanswered by the tolerant reader of
-- apps/api/src/profile/repo.ts (ADR-009 §1). Idempotent: an array is left alone.
UPDATE "profile"
SET "fields" = "fields" || jsonb_build_object('occupation', jsonb_build_array("fields"->'occupation'))
WHERE jsonb_typeof("fields"->'occupation') = 'string';

UPDATE "profile"
SET "fields" = "fields" || jsonb_build_object('field', jsonb_build_array("fields"->'field'))
WHERE jsonb_typeof("fields"->'field') = 'string';
