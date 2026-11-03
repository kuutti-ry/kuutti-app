# ADR-062: One queue to the end of the pool

- Status: accepted 2026-11-01 (#502, the maintainer's decisions of 2026-10-29, 2026-10-31 and 2026-11-01, built as written here; §15 marks what is the agent's and was not put to him; the points under "Open, the maintainer's" are his to confirm or change; amends ADR-007, ADR-008, ADR-011, ADR-014, ADR-031, ADR-032, ADR-034, ADR-035, ADR-036, ADR-037, ADR-038, ADR-039, ADR-041, ADR-042, ADR-044, ADR-055, ADR-056, ADR-060 and ADR-061)
- Date: 2026-11-01
- Follows: TD-11, TD-12, TD-13 and TD-14 (departed from here, see Context), TD-6 (the exposure budget), CLAUDE.md rules 6 and 7 and Product constraints, ADR-034 (the round record), ADR-061 (one home, one pool), #502, #503

## Context

The design limited two things at once: how many cards a day (the round, ten) and how many likes a day (ten). Nanna's reading on 26/10/2026 was that this is patronising and that one can limit only one thing. The design conversation of 29/10/2026 worked through the like economy under each rule (#503) and found that the card limit does nothing the like budget does not do already, while three things the design did not handle are the ones that matter: the most-liked people's inboxes pile up and likes die unread; the most-liked men collect matches they never answer, and the women who liked them back wait; and a person passed once, or who had one conversation, is gone for ever from a pool of five thousand, which drains the most active people's pools first.

So there is one queue, an inbox stop, a your-turn limit and a ladder of clocks. TD-11's daily round, TD-12's single cooldown and TD-13's liked-you cap are the log's, and the log wins where this record and the log disagree. Where this departs: the round is no longer a set of cards, and nothing is built at night.

"No infinite feeds" stands: a pool browsed to its end is finite, and the queue ends (the maintainer's reading, 29/10/2026).

## Decision

1. **One queue, no size.** A person reads everybody who fits them, one card at a time, as far as they like. `round_size`, `liked_you_cap`, `shown_cooldown_days` and `ROUND_ENTRIES_MAX` as a cap go. The day's `rounds` row and its `round_entries` stay as the day's log of what was queued, shown and decided, keeping their names, as do the routes under `/rounds` and the `day` and `position` that address a card. The first read of a Finnish day opens the day's record; nothing is built at night, and `roundsJob` goes. `GET /rounds/today` answers the next cards not yet decided, at most `QUEUE_PAGE` (10), and when none is left it adds the next ten people and answers those. `entries` is null before matching is open for the person, an empty list at the queue's end.

2. **The order** (the maintainer, 29/10/2026 and 01/11/2026):
   1. fish waiting on the person, oldest first; then likes waiting, oldest first; never by fit and never moved by distance;
   2. new people, the nearest band first, then the soft count, then an order fixed for the person and the day (ADR-061 §6);
   3. people seen before, in this order: skipped cards, oldest skip first; passed people past their clock; people liked with no answer past theirs; former conversations past theirs; within each the one shown longest ago first, with no band. Their reason stays `seen_before`.

   No activity band and no sorting by last activity. Seen means displayed or decided: an entry queued and never displayed is nothing, and its person is new again another day. The day's first read deletes the person's own such entries of earlier days.

3. **A skip.** Later is a button beside Like, Pass and the fish, stored as the decision `skip`. It moves on, spends no like, costs nobody a clock, and may be changed until midnight like any decision. The card returns another day, in §2's order. A card displayed and left undecided on an ended day reads as a skip. On a liked-you or fish card a skip is no answer: the like keeps waiting and the card comes back until it expires. Like and pass stay changeable until midnight in Finland (ADR-034 §5), and a phone holding a card past midnight is still refused with `round_expired`.

4. **The inbox stop.** Somebody with `inbox_stop` (30) likes waiting is in nobody's ordinary queue, new or seen before, until they have gone through enough of them to fall below it; it is a hard stop, not a slope (the maintainer, 29/10/2026), and the number is his of 01/11/2026, in `matching_config`. The pile counts only the likes the person's inbox could show now: not expired, of an ended day, unanswered, and the two still in each other's pool. Only a like or a pass clears one. The stop keys on the pile alone, never on gender, whom one seeks or a score, and nothing tells anybody. It holds back no like the person sent: their own likes still arrive. Who gets the look once it lifts follows from §2: everybody's queue shows new people before seen ones, so everyone in the set has one look before anyone a second. An entry already queued for somebody today stays, a queue-length effect.

5. **The your-turn limit.** A conversation is the person's turn when it is open, not archived, and the last thing said in it, a message or a shared contact (the maintainer, 01/11/2026), came from the other person; a match where nothing has been said is both people's turn. Read through what the person may see (`MESSAGE_VISIBLE`), so a shadow ban shows nothing here, but for the one older thing under Consequences. With `your_turn_limit` (8) conversations on their turn a person cannot make a new match: a like or a fish, in the queue or on a liked-you card, answers 409 `your_turn_limit`, in words, with the number. The refusal comes before any look at whether the other person liked, so that it says nothing of them. A pass, a skip and reading go on, and a liked-you card keeps its two weeks. Ending a conversation answers it, and the seven-day archive takes it off the count. The conversation list shows two groups, your turn and their turn, with the count on the first, and a banner from `your_turn_warning` (6). No hidden state and no exemption.

6. **The ladder.** Skip: not today, the queue's order is its clock. Pass: `pass_cooldown_days` (30), and as before a like from the passed person does not reach them meanwhile. A second pass: `second_pass_cooldown_days` (365), the maintainer's of 01/11/2026, marked on the entry (`second_pass`) so that the mark outlasts the first pass's record. A like with no answer: `liked_cooldown_days` (90), the second ask. An ended conversation, by either person or by the silence that archives it: `ended_cooldown_days` (90), both ways, as seen before, counted from the close or the archive. A block: never. The pass's clock is the shorter, so the one who said no gets the first chance to change their mind and the one who asked waits longer to ask again. A like waits `like_expiry_days` and goes, silently, as before.

7. **A second match is a new conversation.** Two people who come back and match open a new conversation; one that stands archived between them is closed as an `unmatch` by the same statement's transaction, so a pair has one conversation they can write in. `Matches.between` means a conversation that is open, or one opened this Finnish day: so that a like which made a match today stays final (ADR-038 §3) even if the conversation has ended, and so that no like falls on an old conversation it did not make.

8. **Filters at once.** Both people's filters are asked on every read of a card and on every like, in `decide`'s transaction, relaxations and a like's waived deal-breakers included (ADR-042 §7). A card that does not fit now is left out while it does not fit; a like on it answers the 404 of a card that can no longer be shown; a pass or a skip asks only the state and the block, so that a like can always be taken back. This answers ADR-034 Open 5 and the register's row of 19/10/2026. Every change of filters or home works on the next read, the narrow ones and the wide ones alike, and a person may therefore aim at somebody with a narrow age, gender and language, or read an answer hidden from the card by flipping a deal-breaker, or narrow down an area by moving home: the maintainer accepted that on 01/11/2026. ADR-061 §5's one reading a night goes with it, and with it `account.home_moved_at`. A card keeps the band its entry was written with. Gender's thirty days stay (ADR-060 §9).

9. **No ceiling on cards.** `exposure_cards_per_day` and the `card` of `photo_fetches_per_day` are 0, which now means off (the maintainer, 01/11/2026). What stands is two automatic alarms and the request limit: `auto_shadow_ban_cards_served` 300 different people's cards in `auto_shadow_ban_cards_served_minutes` 10, and `auto_shadow_ban_photo_fetches` 1,500 card photos in its 60 minutes, his of the same day. At today's 200 an honest reader would have tripped the photo alarm after 35 to 200 cards in an hour. A slowed script is caught by neither and could copy everybody within a day: he accepted that with the choice. The card and photo records go on being written.

10. **The short pool.** A round is short once no new person is left in the queue; the offers of ADR-042 stand, and the phone shows them at the end of the queue. A relaxation adds at most `QUEUE_PAGE` cards at a time, and the queue goes on to the rest of the people it lets in once those are read. There is no room to run out of. The offers read the pool as it stands, a move included.

11. **The queue's end.** "That's everybody for now." then the short pool's offers, then one plain button into What you seek, the same words for everybody, naming no row and no number, so that nobody in a thin set is told to widen (the maintainer, 31/10/2026). Nothing says to come back tomorrow, which in a thin set would be false for a month.

12. **The round push goes** (the maintainer, 01/11/2026). `jobs/round-push.ts`, `unopenedRoundsOf`, `round_push_hour`, `round_push_idle_days`, the `round` kind of a push and its switch. The match and message pushes stay. ADR-055 §6 is over: with no daily set there is nothing ready, and a push that said "new people" would be a read of everybody each night and a daily call to come back.

13. **Rounds are kept a year** (the maintainer, 01/11/2026), `ROUND_RETENTION_DAYS` 365: the night deletes rounds older than that, their entries and relaxations with them. It covers the longest clock, §6's second pass. With §8 it answers both conditions of the hold, so production builds rounds; nothing is read before an admin opens the switch (ADR-060).

14. **The words.** The screen is People, its button See people, Finnish Ihmiset (the maintainer, 01/11/2026). The skip is Later, Myöhemmin, Senare, because Finnish Ohita is already Pass. `seen_before`, `matches_filters` and the other reasons keep their words.

15. **Following from those, the agent's and not put to him:**
    - `QUEUE_PAGE` is 10, a contract constant and no tunable: nobody meets it, and it bounds a read and how often a read walks the pool.
    - Somebody whose matching closed or whose profile stopped being complete, with the day's log open, reads what is left of it and then an empty list, which the phone says as the queue's end. Home tells them why, and no answer tells the two apart.
    - The two budgets stay in the code with 0 for off, the idiom of the automatic rules, rather than being taken out, so that a ceiling can come back from the panel on the day it is needed.
    - The pile counts only the likes the inbox could show now, and only a like or a pass clears one: #502's comment of 31/10/2026 proposed it and the question he answered with 30 described it, but he was not asked about it by itself.
    - The stop holds a person out of seen-before cards too, where the issue says "new card": a second look brings likes as a first one does.
    - `round_built` and `RoundOrdering` go: a set that no longer exists has no size to count. `profile_viewed`, `like` and `pass` stay, their `position` widened. A skip is no event.
    - A pass is a second pass while an earlier one is still kept. Rounds are kept a year and a second pass holds a year, so the earlier one is nearly always gone when the person comes back: the next pass counts as a first, and the clocks run thirty days, a year, thirty days, a year.
    - Liking back, earned likes, the invited friend's fish and the fish at zero stay with #503.

## Consequences

- A read that finds nothing undecided walks the whole pool, every ten cards. `subjectsOfPond` reads all of it (`jobs/pool.ts`), so a person reading three hundred cards a day walks it thirty times. A walk took about 360 ms with 3,400 complete people on the laptop, 01/11/2026, so a few walks a second is what a core holds: enough for an ordinary day, not for thousands of people reading pages in one hour. A `shortcut:` in `round-builder.ts` names what lifts it. `load-smoke` reads the queue, and `docs/runbooks/capacity.md` carries the figure.
- A send takes a conversation out of the archive for both people, a shadow-banned person's send too (TD-13, `insertMessage`, older than this record). The other person sees it come back with nothing new to read, and when the last thing they may see was the banned person's, it is on their turn and can refuse a like at the limit. Deciding the archive per reader would close it; that reaches the list's state as well, so it is left for a change of its own.
- With `ended_cooldown_days` set below `like_expiry_days` in the panel, a like from before an ended conversation can open a new one. The values here, 90 and 14, do not reach it.
- A clock set above 365 in the panel is cut short: the prune forgets what it reads.
- `round_entries` holds what was queued and shown: at five thousand people, at most some 100,000 rows on a heavy day and a year of them, about 15 million rows on a quiet year.
- The third trigger of ADR-056 §1 has come: a route serves cards outside a bounded round. Starting attestation stays his, on its own issue.
- The privacy notice and the DPIA (#190) have to say a year; the police-disclosure runbook says it.
- Reading the first months' measures (#503) reads the round records, so what was shown, skipped and answered stays readable for a year.
- #374's review notes name daily rounds and the exposure cap as what makes the design different; both are gone.

## Alternatives

- **Keep a ceiling of 60 or 300 cards a day.** Stronger against copying, but it keeps the limit Nanna called patronising, or one nobody honest meets. Rejected by the maintainer, 01/11/2026.
- **One new reading a day**: a change of filters or home takes people out at once and brings nobody new until tomorrow, closing the search of §8. Rejected by the maintainer, 01/11/2026: widening at the queue's end should work at once.
- **A second pass that is final.** It would need a mark kept until erasure, and in a thin set the people run out after two turns. Rejected by the maintainer, 01/11/2026.
- **Build the queue in full on the first read.** Five thousand people's entries for each of five thousand people, up to 25 million rows a day. Ten at a time writes what is read.
- **A list of ids on the round row.** A second place for what entries already hold, and one more thing to keep true against the filters.
- **A daily push of new people** and **an activity band**: rejected by the maintainer, 01/11/2026.

## Open, the maintainer's

1. The privacy notice's line on the year, and when production's switch opens: the notice's wording is his, on `kuutti-ry/kuutti-app-site`.
2. Whether #503's model is run again for one pool (its comment of 01/11/2026).
3. The inbox stop's and the alarms' values after the first months' counts: both are in the panel.
