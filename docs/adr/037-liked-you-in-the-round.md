# ADR-037: Liked-you in the round

- Status: accepted 2026-10-20 (#97, built as written here on the maintainer's decisions of that day, #97's comments of 13/10 and 20/10/2026; the points under "Open, the maintainer's" are his to confirm or change)
- Date: 2026-10-20
- Follows: TD-11 (liked-you inside the round, free; the pending-like queue and its expiry), TD-12 (the reason on every card, the pass cooldown), ADR-022 §4 (a break stops no clock), ADR-030 §11 (Block or report on a card), ADR-034 (the round record), ADR-035 (the builder), CLAUDE.md rule 7 and Product constraints; issues #97, #95, #98, #100, #378, #379

## Context

The builder of ADR-035 orders the cards of a round and leaves its first places, the forced ones, to #97: a like reaches the person it was meant for in their next round, first and labelled, for free, and never as a list of its own to be sold. The round record (ADR-034) holds every like given: it is an entry of the liker's round with the decision `like`. On 20/10/2026 the maintainer kept #97 as written, with the fish (#378) to go ahead of ordinary likes when it comes.

## Decision

1. **A waiting like is read from the round record**, with no table of its own: an entry with the decision `like` whose candidate is the person, in a round of the liker's of an ended Finnish day, within `like_expiry_days` of today (a like of fourteen days ago has expired), and not answered: the person has decided nothing on the liker on that day or after it. Only ended days, because a decision may change until midnight (ADR-034 §5): a like that could still be taken back is never shown.
2. **The first places.** The builder (`placesOf`) puts the people whose like waits first, the oldest like first, up to `liked_you_cap`, each with the reason `liked_you`, and no order of any approach moves them (`likedYouPlaces`, the matching slice's). Each must still be somebody the person may meet: of the pond, seen by others and let in, in each other's pool both ways, no hidden field between them (rule 7, the same rule as every card). Somebody whose like waits beyond the cap waits for a later round and is no ordinary card meanwhile, so a like is never shown unlabelled.
3. **What keeps a like away.** A like from somebody the person passed within `pass_cooldown_days`, or with whom they have a conversation, never comes: a recent pass is the person's answer already, and a conversation is a match (ADR-031). A liked-you card left undecided comes back the next day while the like waits; the shown cooldown, which spaces ordinary cards, does not hold it back.
4. **An expired like is nobody's to see.** Past `like_expiry_days` it is gone from every round, the liker may come again as an ordinary card, and nobody is told. The liker learns nothing from any route of what became of the like (TD-11): their own round and their rounds' history read the same whether it was seen, passed, left or expired.
5. **Free, and a break stops no clock.** Liking back a liked-you card is free (ADR-036 §3). A like keeps running out during the person's break as at any other time (ADR-022 §4), and the break screen says so: the line that said everything comes back as it was now says a waiting like can run out meanwhile, without naming the time, which is a row.
6. **Nothing new to erase.** A like is its liker's round entry: an erasure of the liker takes it (their rounds), an erasure of the person takes the entries in which they are a card (ADR-034 §7). The export lists the likes a person gave as decisions of their own rounds, never a like received.

## Consequences

- A like reaches its person within a day of the day it was given, unless the round's first places are full.
- A person liked by many sees them over several days, oldest first; with more than `liked_you_cap` likes arriving a day for long, the newest can expire unseen (TD-13's lower cap for a contested pond waits for #98's contest rule).

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
