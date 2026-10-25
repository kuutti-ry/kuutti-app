# ADR-038: The match

- Status: accepted 2026-10-20 (#100, built as written here on the maintainer's decisions of that day, #100's comment of 20/10/2026; the points under "Open, the maintainer's" are his to confirm or change), amended 2026-10-21 (§1: what a shadow-banned person's round holds, ADR-037 §7) and 2026-10-25 (Open 1: the push half answered, #102, ADR-055 §5; see History)
- Date: 2026-10-20
- Follows: TD-5 (the research event `match`), TD-7 (erasure), TD-11 (a like is scarce), TD-13 (the archive of a silent match), ADR-024 §6 (a shadow ban withholds), ADR-030 §2 (a block), ADR-031 (the conversation as the match's record, §8 the archive), ADR-034 §5 (a decision changes until the day ends), ADR-036 (the day's likes), ADR-037 (liked-you), CLAUDE.md rule 7 and Product constraints; issues #100, #96, #97, #98, #101, #379

## Context

Two likes make a match, and a match is what a like can turn into (#100). ADR-031 made the conversation the match's record and left its opening to #100, in the statement of the second like. ADR-034 §5 lets a decision change until the day ends and left to #100 what becomes of a like taken back after it made a match. On 20/10/2026 the maintainer answered: the match stands, and the like that made it is final, its place in the day's likes spent; any other like may still be taken back.

## Decision

1. **A match is a like meeting a like.** A like of somebody whose like of the person stands, given within `like_expiry_days` (today's included), is a match: `decide` opens the conversation in its own transaction, the earlier liker on side `a` (`openConversation`, the chat slice's). No notification goes out when it opens: migration 0055's triggers fire on updates and on messages, not on this insert, so the other person finds the match at their next read of the conversation list, and anything live waits for Open 1 and #102. No match is made while the person deciding is shadow-banned (ADR-024 §6: their like is recorded as any like and reaches nobody); so that this tells them nothing, their round holds no liked-you or fish places (ADR-037 §7), nor with a block between the two (the card cannot be decided at all, ADR-030 §2, and the statement that looks for the other like asks `blocked_between` once more).
2. **One pair at a time.** A decision first takes both people's account rows, shared and in id order, before any row of a round: erasure and a sanction take an account `FOR UPDATE` before they touch rounds or conversations, so one under way finishes before the decision reads, and one that comes later waits for it to commit; an erasure or a ban then closes the match it opened, and a warning, a shadow ban or a suspension leaves it open as it leaves every conversation (ADR-024, ADR-031 §2). Then the decider's round lock, then a transaction-scoped advisory lock on the pair, so no two transactions wait for each other. The second like reads the first committed, or not at all: two likes at the same moment make exactly one conversation. A like changed while another makes a match of it waits for that one, and then finds the match.
3. **A like that is part of a match is final.** Changing it is refused with 409 `match_made`, in the request's language ("this like made a match, so it stays; you can still end the conversation under Conversations"), nothing written; its place in the day's likes stays spent (ADR-036). The same like again answers the match and writes nothing. Any other like may be taken back until the day ends (ADR-034 §5); one taken back before the other's like makes no match.
4. **The answer names the match.** `PUT /rounds/{day}/entries/{position}/decision` answers 200 with `{ match: { conversationId } | null }`: the conversation the card's like is part of, whether this like made it or one before it; null for a pass and for a like that made none. Nothing in it says whether the other person liked, unless it is a match. The round screen (#379) says it is a match and leads to the conversation.
5. **The match's events.** `match { completed }`, one for each of the two, keyed by `research_id` as every event (ADR-011): `completed` says whether that person's like made it. Never whom.
6. **The archive, the end, erasure.** The night's archive of silent conversations (ADR-031 §8, `silent_match_archive_days`) is the archive of a silent match, from the conversation's opening; a message keeps it, and writing brings it back. A match ends by an unmatch, a block, an erasure or a ban, each the chat's close (ADR-031); two people with a conversation in any state never meet in a round again (ADR-035 §2). Erasure takes the person's rounds and so their likes (ADR-034 §7), and closes their conversations for the other, who keeps their copy (TD-7, ADR-031 §5): nothing new to erase.
7. **No import between the slices.** The chat imports the profile, which imports matching, so matching imports no chat: `app.ts` hands the chat slice's `conversationBetween` and `openConversation` to the round's routes, as it hands the card builder.

## Consequences

- A like back on a liked-you card is a match at once; a match needs no night.
- A person who matched cannot take that like back that day; they can end the conversation.
- The pair lock costs one advisory lock per decision.

## Alternatives considered

- **A match that waits for midnight, when decisions are final:** a like back would not be a match until the next day, and the screen could not say so.
- **Undoing a match while nobody has written:** the maintainer's rule is that a decision that made a match is answered for.
- **A unique constraint on the pair:** a conversation's two people are two rows; the pair lock and the look before the opening keep it to one without a table of pairs.
- **Matching importing the chat:** a cycle through the profile.

## Open, the maintainer's

1. A notice in the app for the person who did not make the match (ADR-032's `match` kind): the conversation appears in their list. The push half is answered (2026-10-25, the maintainer, ADR-055 §5): they are pushed that they have a new match, never by whom.
2. A block that commits while a match is being opened can leave the new conversation open beside the block, since each statement asks the block for itself (ADR-034 §4's residual, the same for every write of the round); the send refuses to write in it (`blocked_between`, ADR-031 §3).

## History

- 2026-10-20: written with #100's build, on the maintainer's decisions of that day.
- 2026-10-20, after the audit of the first cut: §1 says the opening sends no notification (none ever did); §2's accounts are taken first, shared and in id order, since a match opening took them after the round's rows and could deadlock with an erasure and miss a sanction (tested by deterministic interleaving in `matches.test.ts`).
- 2026-10-21 (ADR-037 §7): a shadow-banned person's round holds no liked-you or fish places, so a like back that makes no match cannot tell them of the ban; the residual, two likes on one day, is ADR-037 §7's.
- 2026-10-25 (#102, ADR-055 §5): a match made pushes the person whose earlier like it met, through `Matches.made` after the commit; Open 1 keeps the notice in the app.
