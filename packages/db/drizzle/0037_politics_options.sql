-- Custom SQL migration file, put your code below! --
-- The politics options of #239 (ADR-019, amended 12/10/2026; ADR-009 §1): the
-- coffee party leaves the registry, and "none of them" stands alone. A stored
-- answer is cleaned so that the tolerant reader of apps/api/src/profile/repo.ts
-- does not read the whole field as unanswered: kahvipuolue goes; next to a
-- party, none_of_them goes (the parties are the answer); an array left empty
-- takes the key out. Nobody real holds an answer yet (the maintainer,
-- 12/10/2026): the rows are the demo personas and the synthetic population.
-- Idempotent; rows without a politics array are not touched.
WITH "cleaned" AS (
  SELECT q."account_id",
         (SELECT jsonb_agg(o."value" ORDER BY o."ord")
            FROM jsonb_array_elements_text(q."fields"->'politics') WITH ORDINALITY AS o("value", "ord")
           WHERE o."value" <> 'kahvipuolue'
             AND (o."value" <> 'none_of_them'
                  OR NOT EXISTS (
                    SELECT 1
                      FROM jsonb_array_elements_text(q."fields"->'politics') AS x("value")
                     WHERE x."value" NOT IN ('none_of_them', 'kahvipuolue')))) AS "politics"
    FROM "profile" q
   WHERE jsonb_typeof(q."fields"->'politics') = 'array'
     AND (q."fields"->'politics' @> '["kahvipuolue"]'
          OR (q."fields"->'politics' @> '["none_of_them"]'
              AND jsonb_array_length(q."fields"->'politics') > 1))
)
UPDATE "profile" p
   SET "fields" = CASE
         WHEN c."politics" IS NULL THEN p."fields" - 'politics'
         ELSE jsonb_set(p."fields", '{politics}', c."politics")
       END
  FROM "cleaned" c
 WHERE p."account_id" = c."account_id";
