# ADR-064: A star: somebody marked for later, without a like or a pass

- Status: accepted 2026-11-03 (#575, the maintainer's decisions of that day, built as written here; §10 marks what is the agent's; the points under "Open, the maintainer's" are his to confirm or change; amends ADR-007, ADR-041 and ADR-062)
- Date: 2026-11-03
- Follows: TD-7 (its erasure table names bookmarks, and what it meant by them is in the private log), CLAUDE.md rules 5, 6 and 7 and Product constraints, ADR-007 (erasure and export), ADR-008 §3 (a photo goes through `card_shown`), ADR-041 (velocity), ADR-061 §5 (a band is written with its entry), ADR-062 (one queue), #575

## Context

The maintainer asked on 01/11 and 02/11/2026 for a place to save a person without giving a like or a pass: "it could just be a star, like a bookmark". TD-7 reserved the word and no issue had built it. An undecided card goes with the day and comes back when the queue reaches it, and Later (ADR-062 §3) is the same: the person cannot choose that, or find anybody again. A person who is unsure about somebody, or has run out of likes for the day, had nowhere to put them.

A star is safe only as long as nothing reads it. Used for anybody's order, an inbox rule, exposure or an event it becomes a desirability signal, which CLAUDE.md never builds. So it passes the Product constraints on that condition, and §8 is the condition.

## Decision

The maintainer's of 03/11/2026, each put to him with its alternatives: §2, the first sentence of §3, §5's ten, §6's way in, its no clock and its inbox stop.

1. **A star on the card, not a decision.** One tap fills it and a second clears it, so it needs no Undo. One mark, with no degrees: starred or not, one row per pair (`star`). The card stays where it is, and Like, the fish, Pass and Later work as before. It spends no like and reserves none, so a star with no likes left is allowed. `PUT /rounds/{day}/entries/{position}/star` puts it, by the card's place, under the same locks as a decision: the two accounts in id order, then the round's row. A day that has ended answers `round_expired`.

2. **Deciding from the list.** Opening a starred person shows their card with Like, the fish and Pass, spending what those spend anywhere else.

3. **A like or a pass takes the star off,** so the list holds only the undecided. A fish is a like. It happens in `decide`'s transaction, so one refused or rolled back leaves the star. A skip decides nothing and leaves it.

4. **The queue and the card.** A starred person is no ordinary card: `todayOf` leaves them out of who may still come, new or seen before, and of what a relaxation lets in, and a read of the day's log (`nextCards`) leaves out a card starred and undecided, so that one starred today leaves the queue at the next read. The star feeds nothing else of the walk. Somebody whose like or fish waits keeps coming as a liked-you or fish card until the like expires, with the star on it, because a star changes nothing in the inbox. Taking the star off puts them back where the queue would have them. `POST /stars/{id}/open` writes the card into today's log through the queue's one writer (`addPlaces`), or finds it there as it stands, so it is reported seen and decided by its day and place through the queue's own routes, every rule of them with it, and its band is the one written then (ADR-061 §5). It is served by the card builder and handed to `roundRead`, as a read of the queue is (ADR-008, ADR-041).

5. **How many.** Ten, `stars_max`, the same as a day's likes, so that the list can be emptied in a day. 0 is off. The count is of those the list shows now, so that nobody sees eight and hears that they are full. One more answers 409 `stars_full`, said in words with no number. Because those left out do not count, somebody could keep adding by narrowing their filters, so the rows of one person stop at `STARS_CEILING` (100), a bound of the contract that nobody meets, whatever the panel sets, with the same refusal.

6. **The list.** `GET /stars`, reached by a line on the home screen, shown only when the list shows somebody, by its word and no count. Everybody on it passes now: matching open for the person, both people's filters as a read of the queue asks them (ADR-062 §8), the other active, and not past the inbox stop (ADR-062 §4). A star must not be a way past the stop. Whoever does not pass is left out with no word why, the word "blocked" appears nowhere (ADR-030 §2), and they come back by themselves when they pass again. A star has no clock: it lasts until the person clears it or decides, or either person is erased. The list is ordered by when the person starred, the latest first, and by nothing else. It serves no card and signs no photo: each row has the star's id and never the account's, a name, an age, and the main one of the approved photos the person was shown, whose thumb the phone asks for as any photo's through `card_shown`. `DELETE /stars/{id}` takes a star off, from the row or the card.

7. **The words.** Other apps use a star for a super like, and Kuutti's stronger like is the fish, so the star that is the only one on the list says "Only you can see your stars. Nobody is told." and the list says so too. The list and its refusals never say anything about anybody who has left it.

8. **Nobody is told, and nothing reads it.** A star never reaches the starred person, is in no count and no answer of theirs, and feeds neither anybody's order, nor the inbox stop, nor exposure, nor any research event. Putting and clearing one write no event and no log line that names anybody. A card opened from the list writes the events any card writes, with its place and `seen_before`; nothing in them says a star. This is what lets a star pass the Product constraints, and the first thing to hold it to.

9. **Erasure and export.** `star` goes in the erasure, the stars the person put and those put on them (`eraseStarsOf`, ADR-007 §4). The export carries when each was put, never on whom, and never a star put on the person (`stars`), as ADR-044's export does: it records one person's private interest in another.

10. **Following from those, the agent's.** Told to the maintainer before the build and not objected to, so `assumption` in the register: the star on every kind of card; a liked-you or fish card still coming back; a starred person not offered as a new card and clearing putting them back; the first star's line; the list by when starred; erasure of either and dates alone in the export; opening a star writing into today's log. Not put to him:
    - A card holding a like or a pass takes no star, and the toggle is left off it, since those take it off. Refused as the 404 of a card gone.
    - A like or a pass taken back the same day does not bring the star back: that would need a mark of what was taken off, and the person can star the card again once it holds neither.
    - "First" is the only star the list shows now, not the first ever, so that nothing has to be stored: the line may come again to somebody who emptied their list.
    - An opened card says why it is there as the queue would: liked you or fish where a like waits, and otherwise seen before. A reason of its own would carry the star into `round_reason` and so into the research events, against §8. A shadow-banned person's card never says a like waits (ADR-037 §7), and their like makes no match, as in the queue.
    - The star sits beside the card's reason, in words and with an icon, outlined off and filled on. One-handed it comes down to the thumb's column with Undo (#82). The decision buttons do not change.
    - After a decision on an opened card the screen says it is done and leads back to the list, with Undo still there, rather than leaving by itself: an accidental pass starts a clock of thirty days.
    - Later stays on an opened card, as it is the only way to take back a like or a pass there after Undo.
    - A row of the list clears its star without opening the card, which would have served one.
    - A paused person's list is empty, as they have no queue, and the stars wait.
    - A block leaves the row, out of the list for good, until either person is erased: the same as any left out, with no code of its own.

## Consequences

- A like from the list may come any number of days after the card was first shown, since a star has no clock. The two are asked again then, as every like is.
- Somebody's star on a person who is banned or blocked for good stays a row until either is erased: it is nobody's to read and counts towards nothing but `STARS_CEILING`. Open 3.
- A starred, undecided card keeps the day's round from counting as complete (the register's open row of `completed_at`), as any undecided card does. Nothing reads it but the export.
- Each walk of the pool reads the person's stars once more, one short statement beside the walk's 360 ms (`docs/runbooks/capacity.md`). The list's read asks the pool's whole read only when somebody on it is at the inbox stop's raw count.
- ADR-056 §1's third trigger came with ADR-062. This is one more route that serves a card outside a bounded round, and it reaches only people the person was already served, within the cap, so it adds nobody for a scraper.
- The privacy notice has to name stars (Open 1).

## Migrations

- `0105_stars`, generated: the table, one row per pair, an index for the erasure of the person starred, and a check against a star on oneself.
- `0106_stars_config`, custom (CLAUDE.md rule 10): `INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES (1, 'stars_max', '10'::jsonb, 'migration:0106') ON CONFLICT ("key", "version") DO NOTHING`.

## Alternatives

- **Back into the queue instead of deciding from the list.** Less code, but the list is then only a reminder. Rejected by the maintainer, 03/11/2026.
- **Left out for two weeks and then gone,** as a waiting like: needs a date on the row and a night's sweep, and a clock the queue's filters do not have. **Gone at once:** the strictest, and nothing reappears, but narrowing one's own filters for a minute, or the other person pausing for a week, wipes the star for good. Both rejected by the maintainer, 03/11/2026, for no clock and left out meanwhile.
- **Shown on the list past the inbox stop.** The star is the person's own find and ten likes a day bound the effect, but the pile could then pass thirty through stars. Rejected by the maintainer, 03/11/2026.
- **A column on `round_entries`.** The star would go with the day's log after a year, against no clock, and would have to move from day to day.
- **A list of cards.** Every look at the list would serve up to ten cards and count towards the alarm of ADR-041. A row of a name, an age and a thumb serves none.
- **A reason `starred`.** §10.

## Open, the maintainer's

1. The privacy notice's line on stars: its wording is his, on `kuutti-ry/kuutti-app-site`.
2. The words Star, Starred, Tähti, Tähdellä merkityt, Stjärna and Stjärnmärkta, with the native review (#55). The icon is Lucide's, a placeholder until #410.
3. Whether a block, or a ban for good, should take the stars between the two people off at once rather than at erasure.
