# ADR-036: The day's likes, their first cut

- Status: accepted 2026-10-20 (#98's budget half, built as written here on the maintainer's decisions of that day, #98's comment of 20/10/2026; the points under "Open, the maintainer's" are his to confirm or change)
- Date: 2026-10-20
- Follows: TD-11 (a like stays scarce), TD-14 (budgets that name no gender), TD-15 (a reward may raise a budget), ADR-034 §5 (a decision changes until the day ends, under the round's lock), ADR-035 (the first cut's round), CLAUDE.md rule 10 and Product constraints; issues #98, #97, #378, #85

## Context

A round of ten cards a day (ADR-035) bounds what a person is shown; nothing yet bounds what they like. #98 specifies two budgets by the contest of a person's pond (TD-14) and the research buckets beside them. On 20/10/2026 the maintainer chose the first cut: ten likes a day for everybody, a like back free, a pass never counted; the contest rule, the buckets and the reward's five more wait for the research partner.

## Decision

1. **Counted where it is written.** `decide` counts the likes of the person's round of the day under the round row's lock (ADR-034 §5), in the transaction that writes the like: two devices cannot both pass the count, and a like over the budget is refused before anything is written. The count is of the day's standing decisions, so a like changed to a pass gives its place back, and the same like again writes nothing and is never refused.
2. **The budget** is `like_budget_balanced`, for everybody, whatever their pond's contest. Version 1 took TD-14's twelve for a balanced pond; migration 0070 (`generate --custom`) writes ten as the key's next version, as 0069 writes `round_size` (ADR-035 §3), and names itself in `created_by`:

   ```sql
   INSERT INTO "matching_config" ("version", "key", "value", "created_by")
   SELECT coalesce(max("version"), 0) + 1, 'like_budget_balanced', '10'::jsonb, 'migration:0070'
     FROM "matching_config" WHERE "key" = 'like_budget_balanced';
   ```

   `like_budget_contested` and `contest_ratio_threshold` stay rows that nothing reads yet: TD-14's rule needs no migration when it comes.
3. **A like back is free.** A like on a card whose reason is `liked_you` answers somebody's like rather than sending one: it is not counted, before or after the budget is spent, so a round that opens with liked-you cards (#97) leaves the day's likes for people who are new. A pass is never counted. A fish (#378, ADR-039) is a like that counts, and a like or fish on a `fish` card is free as on a `liked_you` card.
4. **The refusal** is 429 `like_budget_exceeded`, said in the request's language ("you have used today's likes; new ones come after midnight; you can still pass"), with `Retry-After` the seconds until midnight in Finland, as the card budget's refusal is. No research event is emitted for a refused like, and nothing is logged beyond the request's own line.

## Consequences

- At most ten likes a person a day, wherever they live; liking back and passing are never limited.
- The research events of a like are unchanged: a refused like is no event.

## Alternatives considered

- **A count in its own table:** the round's entries are the record of the day's decisions already, and its lock serialises them.
- **Counting every like ever given today, a taken-back one too:** the maintainer's rule is that a decision is the person's own until midnight (ADR-034 §5); a count of standing likes keeps the two consistent.
- **A like back counted until the budget is spent:** it would let a round that opens with liked-you cards use up the day before anybody new was seen.

## Left for later, after the research partner

TD-14's contest rule and its two budgets, the research buckets, approach 2's weights, and the reward's five more likes (#85).

## Open, the maintainer's

1. Whether the app shows how many likes are left today: the first cut's answer says nothing until the refusal (#379 decides the screen).

## History

- 2026-10-20: written with #98's budget half, on the maintainer's decisions of that day.
- 2026-10-20 (#378, ADR-039 §2, §3): a fish counts against the day's likes as a like; a like on a `fish` card is free as one on a `liked_you` card.
