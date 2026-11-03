# ADR-036: The day's likes, their first cut

- Status: accepted 2026-10-20 (#98's budget half, built as written here on the maintainer's decisions of that day, #98's comment of 20/10/2026; the points under "Open, the maintainer's" are his to confirm or change), amended 2026-10-22 (§5: a like earned by an invitation extends the day's budget, #107, ADR-044 §8; see History), amended 2026-10-30 (§6 and Open 1: the round says how many likes are left, the maintainer's of that day, #524; see History); amended 2026-11-01 by ADR-062 (the Consequences: `round_size` is gone and the day's budget binds, #502; see History), and by #503 (the Context by a note in place, §2, §3, §5, §6, the Consequences, the Alternatives and Left for later: no budget by side, a like back spends a like, earned likes withdrawn, and the number counts the day's likes alone, the maintainer's of 29/10, 30/10 and 31/10/2026; see History)
- Date: 2026-10-20
- Follows: TD-11 (a like stays scarce), TD-14 (budgets that name no gender), TD-15 (a reward may raise a budget; since #503 none does), ADR-034 §5 (a decision changes until the day ends, under the round's lock), ADR-035 (the first cut's round), CLAUDE.md rule 10 and Product constraints; issues #98, #97, #378, #85

## Context

A round of ten cards a day (ADR-035) bounds what a person is shown; nothing yet bounds what they like. #98 specifies two budgets by the contest of a person's pond (TD-14) and the research buckets beside them. On 20/10/2026 the maintainer chose the first cut: ten likes a day for everybody, a like back free, a pass never counted; the contest rule, the buckets and the reward's five more wait for the research partner. (Note of 2026-11-01, #503: a like back spends a like since then, and the contest rule, the buckets and the five more are gone: §2, §3, §5, Left for later.)

## Decision

1. **Counted where it is written.** `decide` counts the likes of the person's round of the day under the round row's lock (ADR-034 §5), in the transaction that writes the like: two devices cannot both pass the count, and a like over the budget is refused before anything is written. The count is of the day's standing decisions, so a like changed to a pass gives its place back, and the same like again writes nothing and is never refused.
2. **The budget** is `like_budget_balanced`, the same number for everybody. Version 1 took TD-14's twelve for a balanced pond; migration 0070 (`generate --custom`) writes ten as the key's next version, as 0069 writes `round_size` (ADR-035 §3), and names itself in `created_by`:

   ```sql
   INSERT INTO "matching_config" ("version", "key", "value", "created_by")
   SELECT coalesce(max("version"), 0) + 1, 'like_budget_balanced', '10'::jsonb, 'migration:0070'
     FROM "matching_config" WHERE "key" = 'like_budget_balanced';
   ```

   There is no budget by side and none that moves with how many people seek somebody (the maintainer's of 29/10/2026, #503). `like_budget_contested` and `contest_ratio_threshold`, rows nothing ever read, go by migration 0105, every version of each, and the seed drops them:

   ```sql
   DELETE FROM "matching_config" WHERE "key" IN ('like_budget_contested', 'contest_ratio_threshold');
   ```
3. **A like back spends a like** (the maintainer's of 30/10/2026, #503; it was free from 20/10/2026). A like on a card whose reason is `liked_you` or `fish` answers somebody's like, and it counts like any other: one limit does two jobs, proposals for the average person and answers for the popular one. A pass is never counted. A fish (#378, ADR-039) is a like that counts, which the maintainer kept on 29/10/2026, and a like or fish on a `liked_you` or `fish` card is a like (ADR-039 §2). Following from that, the agent's and not put to him: past the budget a like back is refused as any like is (§4), and the like it would answer keeps waiting, since the refusal writes nothing.
4. **The refusal** is 429 `like_budget_exceeded`, said in the request's language ("you have used today's likes; new ones come after midnight; you can still pass"), with `Retry-After` the seconds until midnight in Finland, as the card budget's refusal is. No research event is emitted for a refused like, and nothing is logged beyond the request's own line.
5. **Withdrawn** (#503, the maintainer's of 31/10/2026): earned likes go altogether, so nothing extends the day, and a reward is a fish (ADR-044 §8).
6. **The round says how many are left** (#524, the maintainer's of 30/10/2026). `likesLeft`, in the round's answer and in every decision's, is the budget less §1's count, zero at the least: whatever `like_budget_balanced` holds counts down to zero. `likesSent` is the one count the refusal and the number read, so the two never disagree, and a change to what a like spends reaches the number by itself. It comes with those answers, never from a read of its own (ADR-008), and it is the person's own, from their own decisions. The screen says it in words beside the decision buttons from the first card, and at zero that new ones come tomorrow. The same words at ten as at one: no colour that warms, no animation, no sound, no push when the likes come back, and no announcement after a decision. The number counts the day's likes and nothing else (the maintainer's of 31/10/2026, #503).

## Consequences

- At most ten likes a person a day, wherever they live, likes back among them (§3); passing is never limited.
- The research events of a like are unchanged: a refused like is no event.
- A like back counts, so a round that opens with liked-you cards can spend the day's likes before its last ordered card, and with ten of them before anybody new is seen. On a round with none, while `like_budget_balanced` is not below `round_size`, the number reaches zero only on the last ordered card (#502).
- The ten stand on #503's model, which is not run again for one pool (the maintainer's of 01/11/2026): the first months' counts from the round records check it (#190).

## Alternatives considered

- **A count in its own table:** the round's entries are the record of the day's decisions already, and its lock serialises them.
- **Counting every like ever given today, a taken-back one too:** the maintainer's rule is that a decision is the person's own until midnight (ADR-034 §5); a count of standing likes keeps the two consistent.
- **A like back counted until the budget is spent:** the first cut set it aside, since it would let a round that opens with liked-you cards use up the day before anybody new was seen. The maintainer reversed that decision on 30/10/2026: a like back spends a like (§3, #503).

## Left for later

Nothing. What stood here on 20/10/2026 is gone: TD-14's contest rule and its two budgets (§2, the maintainer's of 29/10/2026), the research buckets and approach 2's weights (nothing in matching waits on a research partner, his of 31/10/2026, #502), and the reward's five more likes (his of 31/10/2026, #85 closed on it).

## Open, the maintainer's

1. Answered 2026-10-30 (§6, #524): the app shows how many likes are left today.

## History

- 2026-10-20: written with #98's budget half, on the maintainer's decisions of that day.
- 2026-10-20 (#378, ADR-039 §2, §3): a fish counts against the day's likes as a like; a like on a `fish` card is free as one on a `liked_you` card.
- 2026-10-22 (#107, ADR-044 §8): §5 added, the maintainer's of that day. A like earned by an invitation is used by itself once the day's likes are spent, and the day's count leaves out the likes it paid for. #85's explicit "five more likes" is still for later.
- 2026-10-30 (#524, a session of that day): §6 added and Open 1 answered, the maintainer's of that day. The round says how many likes are left, counting from the budget down to zero. The maintainer also decided that liking back spends a like; that is #503's to build, and §3 stands until it lands.
- 2026-11-01 (#502, ADR-062 §1): `round_size` is gone, so the Consequences' number that reaches zero only on a round's last ordered card is over: a queue has no size, and the day's budget binds. A skip, like a pass, is never counted. §3's free like back and §5's earned likes stay with #503 (ADR-062 §15).
- 2026-11-01 (#503): §2, §3, §5, §6, the Consequences, the Alternatives and Left for later amended. The maintainer's of 29/10/2026, #503's table: one budget for everybody, none by side and none moving with a share, so migration 0105 deletes the contest rule's two keys. His of 30/10/2026, #503's comment of that day: liking back spends a like, which reverses the first cut's §3. `likesSent` counts every standing like of the day, and `FREE_LIKES`, renamed `ANSWERS_A_LIKE`, now says only that a fish on such a card is a like (ADR-039 §2). His of 31/10/2026, #503's comment of that day, #85 closed on it: earned likes go altogether, "five more likes" as a choice is withdrawn, and the number counts the day's ten and nothing else, so §5 is withdrawn and §6's `shortcut:` goes from `rounds.ts`. His of 01/11/2026: the model is not run again for one pool. Left for later holds nothing since his word of 31/10/2026 that nothing in matching waits on a research partner.
