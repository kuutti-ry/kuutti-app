-- Custom SQL migration file, put your code below! --
-- The like economy's rest (#503, ADR-036, ADR-044). The contest rule's two keys
-- go whole, every version of each (rules/db.md): the same budget for everybody,
-- the maintainer's of 29/10/2026, and nothing ever read them. The seed has
-- dropped them too.
DELETE FROM "matching_config" WHERE "key" IN ('like_budget_contested', 'contest_ratio_threshold');--> statement-breakpoint

-- Earned likes go, the maintainer's of 31/10/2026, so that the next migration
-- can take `like` out of reward_kind, which a row still naming it would refuse.
-- invitation_reward has never earned one by default.
DELETE FROM "reward" WHERE "kind" = 'like';--> statement-breakpoint

-- invitation_reward's next version, in its new shape, as 0088 writes one: the
-- inviter keeps what the latest version gives, a value set in the panel
-- included, and the invited friend earns a fish too, the maintainer's of
-- 29/10/2026. The seed's second version carries the same row.
INSERT INTO "matching_config" ("version", "key", "value", "created_by")
SELECT "version" + 1, 'invitation_reward',
       jsonb_build_object('inviterFish', "value" -> 'fish', 'friendFish', 1), 'migration:0105'
  FROM "matching_config" WHERE "key" = 'invitation_reward'
 ORDER BY "version" DESC LIMIT 1;
