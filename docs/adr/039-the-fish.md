# ADR-039: The fish, a like that says a little more

- Status: accepted 2026-10-20 (#378, built as written there on the maintainer's decisions of that day; the points under "Open, the maintainer's" are his to confirm or change), amended 2026-10-22 (§7 and the Context: an invitation that counted may earn a fish, the maintainer's of that day, #107, ADR-044 §8; see History)
- Date: 2026-10-20
- Follows: TD-11 (a like stays scarce), TD-12 (the reason on every card), TD-15 (nothing purchasable, rewards earned), ADR-011 (the research events), ADR-034 §5 (a decision changes until the day ends), ADR-036 (the day's likes), ADR-037 (liked-you), ADR-038 (the match), CLAUDE.md rule 10 and Product constraints; issues #378, #95, #97, #98, #100, #379

## Context

The matching document of 7 October gave the round's forced places to "kielo senders, then liked-you" and left the kielo undefined (#95). On 20/10/2026 the maintainer defined it as the first cut's super-like and named it the fish: one a week, a like for every rule, first in the other person's liked-you places, never bought or counted. On 22/10/2026 he let an invitation that counted earn one (§7, ADR-044).

## Decision

1. **A fish is a like with a mark.** `round_entries.fish` (migration 0071, generated, with a check that only a like carries it) beside `decision = 'like'`, so every reader of a like, the day's count, the waiting likes, the match, reads a fish as one. The person chooses `fish` on a card (`RoundChoice`: `like`, `pass`, `fish`) and reads it back so, in the round and in the export ("Sent a fish").
2. **On a card that answers a like it is a like.** A fish on a `liked_you` or `fish` card would answer the other's like, so it is stored as a like and spends no fish; the screen does not offer it there (#379). A fish and a like back on such a card are free of the day's likes (ADR-036 §3).
3. **Its own budget.** `fish_budget` fish in any `fish_window_days`, rolling (migration 0072, 1 in 7), counted from the person's standing fish under the round's lock, the card's own aside, so one changed to a like or a pass the same day is given back and the same fish again is never refused. A fish over the budget is 429 `fish_budget_exceeded`, said in the request's language, with `Retry-After` the wait until the midnight on which the oldest of them leaves the window; nothing is written. A like made a fish was counted in the day's likes already and spends only the fish.
4. **First in the other person's round.** The builder reads the waiting likes as ADR-037 says and orders those with a fish first, each group the oldest like first, up to `liked_you_cap`, labelled `fish` (one more value of `round_reason`, in 0071). No order moves them.
5. **The events.** `like` carries `fish`, and `round_built` counts its `fish` places; nothing else. Keyed by `research_id` as every event.
6. **What nobody learns.** The sender learns of a fish what they learn of a like: a match or nothing. No route counts the fish a person received; there is no list of them and no notification of its own: it arrives with the round, as every like does.
7. **Never bought; earned by an invitation alone.** Nothing buys a fish (TD-15). An invitation that counted may earn its inviter fish, as many as `invitation_reward` says (one by default, the maintainer's of 22/10/2026; ADR-044 §8), and nothing else earns one. An earned fish waits until the window's own are sent and is then used by itself by the next fish, which §3 refuses only when none waits. §3's count leaves out the fish an earned one paid for, so a banked fish never takes next week's place.

## Consequences

- A person may send one fish a week, and it reaches its person ahead of every like.
- A person sent many fish meets them first, oldest first; ordinary likes wait behind them and can expire unseen. One fish a week per sender makes it rare; a cap of fish per round would lift it (#97's comment of 20/10/2026), a row when needed.

## Alternatives considered

- **A third value of `round_decision`:** every reader of a like would have to ask for two values.
- **A separate screen of fish:** an extra screen for a rare event (#378).
- **A fish spent on a liked-you card:** it would buy nothing a like does not, and cost the week's fish.

## Open, the maintainer's

1. The words in the app ("fish", "kala", "fisk"): the round screen's (#379), with the native review.
2. A cap of fish per round, should fish ever crowd out ordinary likes (§ Consequences).

## History

- 2026-10-20: written with #378's build, on the maintainer's decisions of that day.
- 2026-10-22 (#107, ADR-044 §8): §7 and the Context amended, the maintainer's of that day. An invitation that counted may earn its inviter a fish; "never earned" is withdrawn. An earned fish is used once the window's fish are sent, and a fish it paid for is not counted in the window.
