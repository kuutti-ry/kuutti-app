# ADR-041: Velocity: an account that takes in people faster than a person does

- Status: accepted 2026-10-21 (#86's velocity half, built as written here on the maintainer's decisions of that day; the points under "Open, the maintainer's" are his to confirm or change)
- Date: 2026-10-21
- Follows: TD-3 (one box, in-process state), TD-5 (moderation), TD-6 (exposure is counted and budgeted), ADR-008 (the exposure budget, the shown record and the fetch log; its open point, the velocity rules on rounds), ADR-024 (§6 and §7: what a shadow ban does and what the person sees), ADR-026 (§7: what lives in memory and for how long), ADR-033 (the automatic shadow bans: §2 the check, §4 the record, §5 the audit row, §6 the list; Open 1 the reason, Open 6 this rule), ADR-034 (today's round, served through the card builder), CLAUDE.md rules 5 and 6 and Product constraints (every tunable in `matching_config`); issue #86

## Context

TD-6 starts from what cannot be prevented: a verified person can take a screenshot of what they are shown. The controls make what one person can take in bounded and attributable: the day's budget, the shown record and the fetch log (#52, ADR-008). #86 keeps the rest of TD-6's list: velocity detection, and app attestation, which waits for the native batch of #184. `FLAG_SECURE` was dropped on 15/10/2026 (#86's comment), and whether iOS notices a screenshot is still #86's question. Since the round screen (#379) the app shows rounds, so the pace at which a person takes in other people is something the API sees.

Reading the code for #86 showed four things the rules have to fit:

- **A round hands over its day's cards in one read, and nobody gets more cards than their round.** A round holds at most `round_size` (10) plus `liked_you_cap` (10) people, the fish among the liked-you places (ADR-039 §4), and `card_shown` is written once per viewer and person a day (ADR-008 §3). A rate on cards served has nothing to find today.
- **What the app fetches.** A card on the screen fetches its main photo in the card size and a thumb of each other photo, each time it comes on the screen (`PhotoImage`, cached under photo and size); the chat list fetches a thumb per conversation on every read; a profile photo's full size only from the zoom of one's own photos, and a photo sent in a conversation in full in the chat (`purpose = message`, ADR-031 §10). The app never asks for another person's profile photo in the full size.
- **When the app reads the round.** When the round screen comes into sight, and again on a new Finnish day; never on a timer (`useRound`).
- **What a shadow ban stops.** It hides the person from everyone else; their fetches and today's round go on as before (ADR-024 §7), and a round built while it is open holds no liked-you or fish places (ADR-037 §7, ADR-035 §1). Against harvesting it is the moderators' list that acts: a moderator suspends or bans.

The maintainer set the parameters on 21/10/2026: three signals (other people's photos fetched, cards served and reads of the round; not the full size of others as a rule of its own); 120 photos in 60 minutes; cards served switched off (0) while the round bounds them; 30 reads of the round in one minute, counted in memory; a shadow ban on the moderators' list as the consequence; the reason `scraping`. Every number is configurable in the panel like any other tunable.

## Decision

1. **Three rules on ADR-033's seam.** Each applies `shadow_ban` by nobody, with the reason `scraping` (ADR-033 Open 1's alternative, taken for these three; ADR-033's own three keep `other`), a fixed note per rule, the rule's record (ADR-033 §4), the `sanction.apply` audit row with no actor (§5), and the moderators' list with its review hours (§6). They are three more values of `sanction_rule` (migration 0074):
   - **`photo_fetches`**: `auto_shadow_ban_photo_fetches` (120) URLs of other people's profile photos in the card and full sizes, issued to the account within `auto_shadow_ban_photo_fetches_minutes` (60), counted from `photo_access` (`othersPhotoFetchesSince`, the media slice's). A thumb never counts: the chat list asks one per conversation on every read, and 200 pixels are not what a scraper wants. The person's own photos never count, nor a conversation's (`purpose = message`, ADR-031 §10). Every URL counts, the same photo again too, since what is counted is what was handed over; a photo deleted since drops out with its owner unknown.
   - **`cards_served`**: `auto_shadow_ban_cards_served` (0, off) different people whose card the account was served within `auto_shadow_ban_cards_served_minutes` (60), from `card_shown` (`cardsServedSince`), each counted at the day's first serving of their card. Off while the round bounds them. A route that serves cards outside the round is the day to switch it on, above two whole rounds (40 while the caps stay at 10) so that the two rounds either side of midnight never trip it.
   - **`round_reads`**: `auto_shadow_ban_round_reads` (30) reads of `GET /rounds/today` within `auto_shadow_ban_round_reads_minutes` (1), counted when the read was served: a read refused over the day's cards hands over nothing and is not counted. A read that finds no round yet counts like any other.

   A threshold of 0 switches its rule off. Every value is a `matching_config` row (migration 0075, the seed's rows the same), changed in the panel's tunables (#305) with a reason and a `config.change` row, and read on each check, so a new number holds from the next request.

2. **Where and when a rule runs.** As ADR-033 §2 has it: in the request that can trigger it, after what it wrote has committed and before it answers, one transaction under the person's sanction lock (`lockAccountForSanction`), changing no answer; every window starts after the last lift of a shadow ban on the account, so a reversal ends the evidence it judged; a check that fails is logged by its kind (`photo_fetch`, `round_read`) with the error's code. The photo rule runs after a URL of the card or full size was issued by `GET /photos/{id}/{variant}`: not after a thumb, which it never counts, and not after a refusal, which issued nothing. The round's rules run after a served read of today's round, cards served first, as the more direct evidence of what was seen, then the reads. `app.ts` hands each check to the routes (`photoRoutes`, `roundRoutes`), as it hands the chat its own, so neither the media nor the matching slice imports safety.

   These checks run on reads, far more often than ADR-033's run on reports and openers, so each is measured first without the lock, the person's standing with it (`standingOf`: erased, already hidden, the last lift), and takes the lock only when a rule is met there and the person is in sight. So the one request that applies a ban is the only one that pays for the lock: a person already hidden is never locked again by these checks, and a ban shows in no later answer's time, which would otherwise tell the person, and tell them the threshold (the security review of #86). That misses nothing: until the check under the lock the count only grows, the last lift only narrows it, and the last request of a burst to commit is measured after every earlier one has. Two checks that both meet a rule apply one ban: the second waits on the first's lock and finds the person hidden.

3. **The round's reads live in memory.** Nothing stores a read. Each account's read times within the window are kept in the process (`roundReadRule`, `safety/automatic.ts`), one log per app, at most the threshold's worth, which is all a count needs to reach it, and none while the rule is off. Once a window, whether or not more reads come, every account is trimmed to the window and the empty ones are dropped, on a timer that runs only while something is kept and never holds the process open: a time is held two windows at most, as the limiter holds a key (ADR-026 §7). So there is nothing to erase, export or sweep in the database. A restart forgets the reads, and a second instance would count its own (TD-3: one box). A window lengthened or a threshold raised in the panel counts from what was kept under the earlier value, so for one window it sees less than it says; a longer window keeps the times as long as it says.

4. **The rules name nobody, and say only counts and times.** The ban's log line is the rule and its count; the fetcher's own request lines are as they were; the owners of the photos fetched reach no line and no record. The record is the rule, the count and the first counted event (ADR-033 §4); the panel says it as "Was handed 120 URLs of other people's photos in the card and full sizes", "Was served the cards of 45 people" and "Read the day's round 30 times", between the first event and the ban. Nothing of it is a research event (rule 5, ADR-008 §3).

## Consequences

- A script that takes the day's photos at machine speed is out of everyone else's sight within the hour, and on the moderators' list. One that keeps under the numbers is still bounded by the day's budget (ADR-008 §1). The rules do not stop the harvest itself: the person still sees what they were shown until a moderator suspends or bans (ADR-024).
- False positives fall on people who go over a round's cards again and again, or in and out of the round screen. A full round fetches 10 to 20 card-size photos, one per card and more with Undo, so 120 an hour is several rounds' worth; 30 reads a minute is one every two seconds. A moderator judges by counts and times, never by what was seen.
- One more count and one standing read with each card-size or full-size URL and each round read, and the sanction lock only on the request that applies a ban; each reader of the round keeps at most the threshold's worth of numbers in memory, for two windows at most.
- The thresholds are public in this repository; values changed in the panel are not. A script that reads them can pace itself under them, and then it is the day's budget that holds.
- A crash between the request and its check misses that event until the next one; a restart forgets the reads.

## Alternatives considered

- **A throttle**, refusing fetches past a pace: it changes answers, which ADR-033 §2 rules out, and tells a script the pace to keep to; the day's budget already refuses.
- **Stopping a shadow-banned person's own fetches** too: it stops the harvest at once, but every shadow ban would then show to the person who has one, against ADR-024 §7. The maintainer chose the list.
- **A flag for the moderators with no ban**: a new kind of record and a queue beside the automatic bans.
- **A table of round reads**: survives a restart, but needs erasure, a line in the export and a sweep, for a one-minute window.
- **The full size of others as a rule of its own**: the app never asks for it, so a few in a day would mean another client. Left out by the maintainer; a candidate if attestation is long in coming.
- **Counting thumbs**: the chat list's one per conversation per read would trip the rule on a person with many conversations.
- **Counting misses** (`not_visible`, ADR-008 §3): a log line only, nothing stored; a photo id cannot be guessed, and a miss has honest causes (a photo deleted, a block since). A metric filter on the line is the place for it if enumeration ever shows.

## Open, the maintainer's

1. App attestation (#86): settled by ADR-056 on 2026-10-25. Not now; it comes back when update signing returns, Kuutti is on Google Play or a route serves cards outside the round, in ADR-056 §2's shape, refusing only on iOS in production and marking a session for these rules everywhere else.
2. Whether iOS notices a screenshot: settled by ADR-056 on 2026-10-25. Never, on either platform (§4 there).
3. `cards_served`'s first value, on the day a route serves cards outside the round: above two rounds' places while `round_size` and `liked_you_cap` stay at 10.
4. Whether `scraping` becomes the reason of ADR-033's message rules too (its Open 1).

## History

- 2026-10-21: written with #86's velocity half, on the maintainer's parameters of that day. Before the pull request, its review moved the person's standing into the measure without the lock (a hidden person had paid for the lock on every request after the ban), put the round's reads on a timer sweep with at most the threshold's worth per account, and corrected what the app fetches in full and what a shadow ban does to later rounds.
- 2026-10-25 (#86, ADR-056): Open 1 and 2 settled. Another account's photo is no longer served in the full size (ADR-056 §3, amending ADR-008 §3), so `photo_fetches` meets new card URLs only; a full-size row of someone else's photo inside the window is one issued before. The rule, its count and its panel text are unchanged.
