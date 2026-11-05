# ADR-037: Liked-you in the round

- Status: accepted 2026-10-20 (#97, built as written here on the maintainer's decisions of that day, #97's comments of 13/10 and 20/10/2026; the points under "Open, the maintainer's" are his to confirm or change), amended 2026-10-21 (§7: no liked-you or fish places for a shadow-banned person, the maintainer's of that day; §1: a like on a relaxed card waives the liker's deal-breakers that card came in under for that one person, #99, ADR-042 §7; see History); amended 2026-11-01 by ADR-062 (§2: no cap, every waiting like comes first; §3: the ladder's clocks, and a skip is no answer; the Consequences; Open 1, 2 and 3 answered; #502; see History), and by #503 (§5: a like back spends a like, the maintainer's of 30/10/2026, ADR-036 §3; see History)
- Date: 2026-10-20
- Follows: TD-11 (liked-you inside the round, free; the pending-like queue and its expiry), TD-12 (the reason on every card, the pass cooldown), TD-13 (the lower cap for a contested pond, gone with the contest rule, ADR-036 §2), ADR-022 §4 (a break stops no clock), ADR-030 §11 (Block or report on a card), ADR-034 (the round record), ADR-035 (the builder), CLAUDE.md rule 7 and Product constraints; issues #97, #95, #98, #100, #378, #379

## Context

The builder of ADR-035 orders the cards of a round and leaves its first places, the forced ones, to #97: a like reaches the person it was meant for in their next round, first and labelled, for free, and never as a list of its own to be sold. The round record (ADR-034) holds every like given: it is an entry of the liker's round with the decision `like`. On 20/10/2026 the maintainer kept #97 as written, with the fish (#378) to go ahead of ordinary likes when it comes.

## Decision

1. **A waiting like is read from the round record**, with no table of its own: an entry with the decision `like` whose candidate is the person, in a round of the liker's of an ended Finnish day, within `like_expiry_days` of today (a like of fourteen days ago has expired), and not answered: the person has decided nothing on the liker on that day or after it. Only ended days, because a decision may change until midnight (ADR-034 §5): a like that could still be taken back is never shown.
2. **The first places.** The builder (`placesOf`) puts the people whose like waits first, the oldest like first, up to `liked_you_cap`, each with the reason `liked_you`, and no order of any approach moves them (`likedYouPlaces`, the matching slice's). Each must still be somebody the person may meet: of the pond, complete and seen by others, in each other's pool both ways, no hidden field between them (rule 7, the same rule as every card). Somebody whose like waits beyond the cap waits for a later round and is no ordinary card meanwhile, so a like is never shown unlabelled.
3. **What keeps a like away.** A like from somebody the person passed within `pass_cooldown_days`, or with whom they have a conversation, never comes: a recent pass is the person's answer already, and a conversation is a match (ADR-031). A liked-you card left undecided comes back the next day while the like waits; the shown cooldown, which spaces ordinary cards, does not hold it back.
4. **An expired like is nobody's to see.** Past `like_expiry_days` it is gone from every round, the liker may come again as an ordinary card, and nobody is told. The liker learns nothing from any route of what became of the like (TD-11): their own round and their rounds' history read the same whether it was seen, passed, left or expired.
5. **A like back spends a like, and a break stops no clock.** Liking back a liked-you card spends one of the day's likes (the maintainer's of 30/10/2026, #503, ADR-036 §3; it was free from 20/10/2026). A like keeps running out during the person's break as at any other time (ADR-022 §4), and the break screen says so: the line that said everything comes back as it was now says a waiting like can run out meanwhile, without naming the time, which is a row.
6. **Nothing new to erase.** A like is its liker's round entry: an erasure of the liker takes it (their rounds), an erasure of the person takes the entries in which they are a card (ADR-034 §7). The export lists the likes a person gave as decisions of their own rounds, never a like received.
7. **None while shadow-banned** (the maintainer, 21/10/2026). A shadow-banned person's round holds no liked-you or fish places. Their like back would make no match (ADR-038 §1: none is made while the decider is shadow-banned), where everybody else's always does, and so tell them of the ban, which a shadow ban never may (ADR-024 §7). The likes wait for the lift with their clock running (§1), and their people are no ordinary cards meanwhile (§2), so none of them is met unlabelled. An automatic one is reviewed within two days (ADR-033), well inside `like_expiry_days`; a like that runs out during a longer ban is gone, as during a break (ADR-022 §4). What is left: a like given today, by somebody who is the shadow-banned person's ordinary card, and answered the same day, still makes no match; it needs both likes on one day and is accepted as a rare tell.

## Consequences

- A like reaches its person within a day of the day it was given, unless the round's first places are full.
- A person liked by many sees them over several days, oldest first; with more than `liked_you_cap` likes arriving a day for long, the newest can expire unseen (TD-13's lower cap for a contested pond went with the contest rule, ADR-036 §2).

## Alternatives considered

- **A pending-like table:** the round record holds the like, its day and its time already; a second copy would need its own erasure and its own consistency.
- **Showing a like of today at once:** it could be taken back before midnight, after the person saw it.
- **Letting a like through a recent pass:** the person said no already; their pass cooldown is theirs.
- **Overflow as ordinary cards:** a person would meet a liker without knowing they liked them, and decide them as a stranger.

## Open, the maintainer's

1. A like from somebody the person passed within the pass cooldown never comes (§3).
2. A liked-you card left undecided comes back every day until the like expires (§3).
3. The fish (#378) takes the first places ahead of ordinary likes; a cap of its own on the fish (a guard for ordinary likes, #97's comment of 20/10) waits until it happens.

## History

- 2026-10-20: written with #97's build, on the maintainer's decisions of that day.
- 2026-10-20 (#378, ADR-039 §4): those whose waiting like is a fish take the first places ahead of the rest, labelled `fish`.
- 2026-10-21: §7, no liked-you or fish places for a shadow-banned person, the maintainer's choice of that day after the audit of the first cut found that a like back told them of the ban.
- 2026-10-21 (#99, ADR-042 §7): §1 amended, the maintainer's of that day. A like given on a relaxed card counts as the liker accepting that one person: the waiting like's place asks the pool both ways with the liker's deal-breakers that card came in under (`relaxed_with`) set aside, and every other filter of either side as always.
- 2026-11-01 (#500, ADR-060 §3): nobody is let in any more, so §2 asks that the liker is complete, as every card's person is (`subjectsOfPond`).
- 2026-11-01 (#502, ADR-062 §1, §2, §3, §6): `liked_you_cap` goes. §2's people whose like waits all come first, however many, fish first and each group the oldest first, never moved by fit or distance, at most `QUEUE_PAGE` a read (`inboxOf` and `nextPlaces` in `placesOf`'s place), and a like no longer waits beyond a cap: what bounds what arrives is the inbox stop (§4 there). So the Consequences' full first places, and the newest likes expiring unseen behind them, are over; a like now waits until its person reads on or is away. "Next round" reads the next read. §3: the pass's clock is `pass_cooldown_days`, now 30, or `second_pass_cooldown_days` after a second pass, which answers Open 1, and a conversation keeps a like away while it stands and for `ended_cooldown_days` after it. The shown cooldown is gone, and a skip is no answer: the like keeps waiting and the card comes back until it expires, which answers Open 2. No cap of fish: nothing is crowded out of a queue with no cut (#502), which answers Open 3. §5's free like back stays with #503 (ADR-062 §15).
- 2026-11-01 (#503, ADR-036 §3): §5 amended, the maintainer's of 30/10/2026. Liking back a liked-you card spends one of the day's likes.
