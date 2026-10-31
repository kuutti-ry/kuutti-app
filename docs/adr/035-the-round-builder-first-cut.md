# ADR-035: The round builder, its first cut

- Status: accepted 2026-10-20 (#95, built as written here on the maintainer's decisions of that day, #95's comment of 20/10/2026; the points under "Open, the maintainer's" are his to confirm or change), amended 2026-10-21 (§1: a shadow-banned person's round holds no liked-you or fish places, ADR-037 §7; §2 and §3: new people first, then the order of coming back, and only opened rounds counted, #99, ADR-042 §1; see History); amended 2026-10-31 by ADR-060 (§1, §2, §4 and §5: the builder reads a pond's switch and the person's completeness, #500)
- Date: 2026-10-20
- Follows: TD-10 (the gate), TD-11 (rounds for admitted people with a complete profile), TD-12 (the reason on every card, the cooldowns), TD-13 (the archive of a silent match), TD-14 (gender-neutral rules), ADR-011 §4 (the registry), ADR-015 §1 and §5 (the pool both ways, an open gate), ADR-019 §1 and §5 (the soft count, the hidden field), ADR-024 §6 (a shadow ban withholds), ADR-031 (the conversation as the match's record), ADR-034 §3 and §8 (the day, the one writer), CLAUDE.md rules 6, 7 and 10 and Product constraints; issues #95, #97, #98, #99, #100, #378, #379

## Context

ADR-034 built the round record and nothing that writes it: a person whose matching has opened (#94) reads a day with no cards. The matching document of 7 October specifies a full builder: forced places, a round sized to the pool, two logged random places, an exposure floor, and three ways of ordering for the research partner to compare. On 20/10/2026 the maintainer chose to start with basic logic and to let the research partner change the approach afterwards: a round of ten cards, ordered by the soft matches; ten likes a day with a like back free (#98); a super-like, the fish (#378); everything else after the partner has spoken. #95's comment of that day lists the split. This record is the first cut.

## Decision

1. **Who gets a round:** everybody complete, active or shadow-banned, in a pond an admin has opened (ADR-060 §3, §5, in place of `gate.opened_at`). A shadow-banned person's round is like anybody's: the ban withholds the person from others, not others from the person (ADR-024 §6); only its liked-you and fish places are left out, so that a like back making no match tells them nothing (ADR-037 §7). Paused, suspended, banned and erased accounts get none.
2. **Whom it holds.** The pond is read by one reader (`subjectsOfPond`, `jobs/pool.ts`, ADR-060 §5). A candidate is:
   - complete and seen by others (`active`);
   - in each other's pool, both ways (`inEachOthersPool`, rule 7);
   - not kept apart by a hidden field (ADR-019 §5): when either person hides from their own field and the two named one field in common, neither is the other's card;
   - not somebody with whom the person has a conversation, whatever its state (ADR-031: the conversation is the match's record, so a pair that matched never meets again in rounds);
   - not in one of the person's rounds of the last `shown_cooldown_days`, nor passed within `pass_cooldown_days` (TD-12). A day exactly that far back is outside it: shown thirty days ago comes back today. Somebody shown in an earlier round, past both, comes back with the reason `seen_before`; everybody else's reason is `matches_filters`.
3. **The order and the size** (`roundOrder`, the matching slice's): the most soft matches first (`softMatches`, approach 1, counted without weights); equal counts in the order of a SHA-256 of the day, the person and the candidate, which differs from person to person and day to day and is the same whenever that day's round is built again; at most `round_size`. Fewer candidates make a shorter round and none an empty one: nothing fills it. `round_size` is ten from migration 0069 (`generate --custom`), which writes the next version of the key and names itself in `created_by`, with no reason, as every version a migration writes:

   ```sql
   INSERT INTO "matching_config" ("version", "key", "value", "created_by")
   SELECT coalesce(max("version"), 0) + 1, 'round_size', '10'::jsonb, 'migration:0069'
     FROM "matching_config" WHERE "key" = 'round_size';
   ```

   The next version and not version 2, so a value set in the panel before the migration ran (#305) is followed rather than kept; on a database with only version 1 it is version 2, as the seed's `MATCHING_CONFIG_V2` writes it.
4. **The night.** The job `round-builder` builds the Finnish day that is (at 04:00 it has begun). A pond is read once; each person's history is one query, their round one transaction through `saveRound` (ADR-034 §8). Somebody whose round for the day exists already is left as they are. One person's round that fails to build is a log line naming the account and a count; everybody else's is built, and the day's first read tries again (§5). The job's line carries counts only: ponds, rounds built, cards, failures.
5. **The day's first read builds a missing round.** `GET /rounds/today` that finds no round for the day asks the builder for the caller's alone (`buildRoundOf`, handed in by `app.ts`, as the card builder is), and reads again if a round for the day stands now, whoever wrote it. This amends ADR-034 §3: entries are null while the caller has no round for the day, which is when their matching has not opened, and an empty list is a round with nobody to show. It covers a gate that opened at a first ask during the day, a profile completed after the night, the hours between midnight and the night's jobs, and a build that failed at night. Two reads at once both build; `saveRound` keeps the first, and the read that lost answers with the round the other wrote (`buildRoundOf` says whether a round stands, not whether it wrote one). The person is asked alone first, so one whose profile no longer counts as complete, though their gate is open, costs no read of the pond on each visit. It reads the person's whole pond for one round: a few hundred milliseconds at five thousand people, at most once a person a day, and only when the night built none.
6. **Research.** `round_built` names its ordering (`ordering: "count"`), so the rounds of a later ordering are told apart from the first cut's (a closed list, as `reason` is: ADR-011 §4's no string field holds). The first cut's rounds have no random places, so they are no uniform sample of anybody's pool; the name says which rounds those are.
7. **Not in production yet.** Neither the night's job nor the first read builds anything where `APP_ENV` is `production`, until the maintainer has set how long rounds are kept (ADR-034 Open 2): a `shortcut:` in `boot.ts` and `app.ts`, which his answer lifts.

## Consequences

- Everybody whose matching is open has at most `round_size` ordered cards a day (ten), the ones most like them on the soft fields first, after up to `liked_you_cap` liked-you places (#97, ADR-037), and never more than the contract's `ROUND_ENTRIES_MAX` (fifty) in all; nobody a hard filter excludes in either direction.
- Every night writes up to fifty thousand ordered entries at five thousand people, and the liked-you places on top of them: at most a hundred thousand with today's rows, above ADR-034's estimate of sixty thousand, which the rounds' retention (ADR-034 Open 2) should be weighed against.
- The night costs a pond's read, the same comparison of everybody with everybody as the gate's count, and a query and a transaction a person.
- A like given today reaches nobody until #97 puts it into the liked person's round; the first cut's forced places are #97's and #378's.

## Alternatives considered

- **Building at the first read only:** rounds only for people who open the app, but the night is where the exposure floor and the research arms will look at everybody at once, and `rules/api.md` names the 04:00 builder. Both are kept.
- **Random order:** the first proposal of 20/10; the maintainer chose the soft matches.
- **A generator seeded by the day and the person for the ties:** a hash of the pair needs no generator state, and gives the same order whatever order the people are read in.
- **A match table to keep matched pairs apart:** #100 has none yet, and the conversation is the record (ADR-031).
- **Round size as a constant, or as an edit of version 1:** a tunable is a row and a new value a new version (`rules/db.md`).

## Left for later, after the research partner

Liked-you's forced places, its queue and its expiry (#97, next) and the fish ahead of them (#378); the round sized to the pool (`round_size_min`); the two random places and their logged probability; the exposure floor; `impression_cap_per_day` in the candidate set; the other orderings and the research buckets (#98); the tie of zero matches first, which needs #100's matches; the order in which people come back, and relaxing a filter (#99).

## Open, the maintainer's

1. How long rounds are kept (ADR-034 Open 2); until then nothing is built in production (§7).
2. The cooldown's edge: a day exactly `shown_cooldown_days` back is outside it (§2).
3. A like given and never answered: past the cooldown the person comes back as seen before, and the like can be given again (#99's order of coming back later).
4. A conversation of any state keeps two people apart for good, an ended one included (§2).
5. A field in common is enough for a hidden field to keep two people apart, of the several each may name (ADR-019, its history of 10/10).

## History

- 2026-10-20: written with #95's first cut, on the maintainer's decisions of that day.
- 2026-10-20 (#97, ADR-037): the round's first places are the people whose like waits on the person; the shown cooldown spaces ordinary cards only, a recent pass and a conversation keep a like away too.
- 2026-10-20, after the audit of the first cut: §5's lost race answers the other read's round, and the person is asked alone before the pond is read; the builder caps a round at `ROUND_ENTRIES_MAX`, the liked-you places first; the Consequences count the liked-you places of #97.
- 2026-10-21 (ADR-037 §7): §1's shadow-banned round holds no liked-you or fish places.
- 2026-10-21 (#99, ADR-042 §1): §2 and §3 amended. The ordered places take new people first, by their soft matches; people past both cooldowns come back only after them, those left undecided or liked first, then those passed, each the one shown longest ago first, equal days in the hash order (`comingBackOrder`). The cooldowns, `seen_before` and that order read only rounds the person opened (`opened_at`). "Left for later"'s order of coming back and relaxing a filter are built (#99), and Open 3 is answered: a like never answered comes back with the undecided.
