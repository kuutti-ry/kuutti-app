-- Custom SQL migration file, put your code below! --
-- A second pond, Finland (#174, ADR-010 §12): a sibling of the capital region,
-- not its parent, so the counter and the gate work per pond as they do today
-- and nothing reads the tree yet. The seed writes the same row
-- (packages/db/src/seed.ts, SEED_PONDS); a deployed database gets it here.
-- Names in the person's language come from the catalogue by slug
-- (pond.name.<slug> in messages.yaml); the Finnish forms stay the columns.
INSERT INTO "ponds" ("slug", "name_nominative", "name_inessive", "parent_id")
VALUES ('suomi', 'Suomi', 'Suomessa', NULL)
ON CONFLICT ("slug") DO NOTHING;
