# ADR-039: The fish, a like that says a little more

- Status: accepted 2026-10-20 (#378, built as written there on the maintainer's decisions of that day; the points under "Open, the maintainer's" are his to confirm or change), amended 2026-10-22 (§7 and the Context: an invitation that counted may earn a fish, the maintainer's of that day, #107, ADR-044 §8; see History), amended 2026-10-29 (the Context, §3, §6, §7 and the Consequences: one fish a calendar week, Monday to Sunday, and the round offers one only while it can go, the maintainer's of that day, #475; see History), amended 2026-10-30 (§6: the day's likes have their own number, #524; see History)
- Date: 2026-10-20
- Follows: TD-11 (a like stays scarce), TD-12 (the reason on every card), TD-15 (nothing purchasable, rewards earned), ADR-011 (the research events), ADR-034 §5 (a decision changes until the day ends), ADR-036 (the day's likes), ADR-037 (liked-you), ADR-038 (the match), CLAUDE.md rule 10 and Product constraints; issues #378, #95, #97, #98, #100, #379

## Context

The matching document of 7 October gave the round's forced places to "kielo senders, then liked-you" and left the kielo undefined (#95). On 20/10/2026 the maintainer defined it as the first cut's super-like and named it the fish: one a week, a like for every rule, first in the other person's liked-you places, never bought or counted. On 22/10/2026 he let an invitation that counted earn one (§7, ADR-044). On 29/10/2026 he made it one a calendar week, Monday to Sunday, where it had been one in any seven days, and said the round need not tell when the next comes, only stop offering it once it is spent: the next is Monday's (#475).

## Decision

1. **A fish is a like with a mark.** `round_entries.fish` (migration 0071, generated, with a check that only a like carries it) beside `decision = 'like'`, so every reader of a like, the day's count, the waiting likes, the match, reads a fish as one. The person chooses `fish` on a card (`RoundChoice`: `like`, `pass`, `fish`) and reads it back so, in the round and in the export ("Sent a fish").
2. **On a card that answers a like it is a like.** A fish on a `liked_you` or `fish` card would answer the other's like, so it is stored as a like and spends no fish; the screen does not offer it there (#379). A fish and a like back on such a card are free of the day's likes (ADR-036 §3).
3. **Its own budget.** `fish_budget` fish in each period of `fish_window_days` counted from a Monday (migration 0072, 1 in 7), so the calendar week, Monday to Sunday in Finland (#475; until then any seven days, rolling). A window of 0, which the panel allows, reads as a day. Counted from the person's standing fish under the round's lock, the card's own aside, so one changed to a like or a pass the same day is given back and the same fish again is never refused. A fish over the budget is 429 `fish_budget_exceeded`, said in the request's language, with `Retry-After` the wait until the midnight that begins the next period, a Monday's; nothing is written. A like made a fish was counted in the day's likes already and spends only the fish.
4. **First in the other person's round.** The builder reads the waiting likes as ADR-037 says and orders those with a fish first, each group the oldest like first, up to `liked_you_cap`, labelled `fish` (one more value of `round_reason`, in 0071). No order moves them.
5. **The events.** `like` carries `fish`, and `round_built` counts its `fish` places; nothing else. Keyed by `research_id` as every event.
6. **What nobody learns.** The sender learns of a fish what they learn of a like: a match or nothing. No route counts the fish a person received; there is no list of them and no notification of its own: it arrives with the round, as every like does. The sender's own round says one thing of their own fish (#475): `fishToSend`, whether the fish's budget lets them send one today, the window's own or an earned one (§7), in the round and in every decision's answer, from the count §3 refuses by. Never a count, nor when the next comes; the day's likes, which a fish counts in too, have their own number (`likesLeft`, ADR-036 §6). The screen offers Send a fish while it is true and on the card that holds the fish, and leaves it out otherwise, as on a card that answers a like; the refusal stays, for a second phone that sent the day's fish meanwhile. One thing it can tell: a candidate's erasure deletes the entries they are a card in (ADR-034), the fish to them included, so if the person fished today erases their account the same day, the sender's button comes back. A block, a sanction or a shadow ban keeps the entry and changes nothing. Accepted: one person, the same day, and only an erasure.
7. **Never bought; earned by an invitation alone.** Nothing buys a fish (TD-15). An invitation that counted may earn its inviter fish, as many as `invitation_reward` says (one by default, the maintainer's of 22/10/2026; ADR-044 §8), and nothing else earns one. An earned fish waits until the window's own are sent and is then used by itself by the next fish, which §3 refuses only when none waits. §3's count leaves out the fish an earned one paid for, so a banked fish never takes the next window's place.

## Consequences

- A person may send one fish a calendar week, and it reaches its person ahead of every like. A fish sent on Sunday and the next on Monday are a day apart.
- A person sent many fish meets them first, oldest first; ordinary likes wait behind them and can expire unseen. One fish a week per sender makes it rare; a cap of fish per round would lift it (#97's comment of 20/10/2026), a row when needed.
- The next fish comes on Monday, which everybody knows, so the screen says nothing of when (the maintainer's of 29/10/2026): the button stays away until then with no word of why. Saying the day would be a field of its own.

## Alternatives considered

- **A third value of `round_decision`:** every reader of a like would have to ask for two values.
- **A separate screen of fish:** an extra screen for a rare event (#378).
- **A fish spent on a liked-you card:** it would buy nothing a like does not, and cost the window's fish.

## Open, the maintainer's

1. The words in the app ("fish", "kala", "fisk"): the round screen's (#379), with the native review.
2. A cap of fish per round, should fish ever crowd out ordinary likes (§ Consequences).

## History

- 2026-10-20: written with #378's build, on the maintainer's decisions of that day.
- 2026-10-22 (#107, ADR-044 §8): §7 and the Context amended, the maintainer's of that day. An invitation that counted may earn its inviter a fish; "never earned" is withdrawn. An earned fish is used once the window's fish are sent, and a fish it paid for is not counted in the window.
- 2026-10-29 (#475, a session of that day): the Context, §3, §6, §7 and the Consequences amended, the maintainer's of that day. One fish a calendar week, Monday to Sunday: `fish_window_days` is counted in periods from a Monday, no longer rolling, so its 7 is the week, and a 1 set in the panel would be the calendar day. The maintainer first chose one a day the same day, then the week. The round and every decision's answer say whether the caller can send a fish today, and the screen offers it only then; #475's proposed line naming the earliest day for the next is not built, and the phone no longer names that day when a fish is refused. The API keeps `Retry-After` (§3). ADR-038 §4 and ADR-044 §8 are amended the same day.
- 2026-10-30 (#524, ADR-036 §6): §6 amended. The round and each decision's answer now say how many of the day's likes are left, a fish counted in them; what they say of the fish is unchanged.
