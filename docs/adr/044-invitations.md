# ADR-044: Invitations, and the reward they earn

- Status: accepted 2026-10-22 (#107, built as written here on the maintainer's decisions of that day; the points under "Open, the maintainer's" are his to confirm or change), amended 2026-10-22 (§12: the code in onboarding counts no step, #418) and 2026-10-29 (§8: the round asks whether an earned fish waits, #475; see History); amended 2026-10-31 by ADR-060 (§1, §6 and §7: completeness itself in place of a gate row, #500)
- Date: 2026-10-22
- Follows: TD-15 (the earned, non-transferable reward ledger), TD-10 (the pond gate), TD-11 (a like stays scarce), TD-7 (erasure), TD-5 (what the research events may carry), ADR-007 (erasure and export, amended), ADR-011 §9 (nothing in an event that links two pseudonyms), ADR-015 (the pond gate), ADR-024 §7 (a shadow ban never shows), ADR-027 §3 (one answer for every code that does not work), ADR-032 (the notices, amended), ADR-036 (the day's likes, amended), ADR-039 (the fish, amended), ADR-043 (a code kept as its hash), CLAUDE.md rule 2, rule 6, rule 10 and Product constraints (nothing purchasable; every tunable in `matching_config`); issues #107, #85, #184, #190

## Context

Kuutti grows by word of mouth or not at all: no ads, no ad SDKs, nothing purchasable (Product constraints). #107 asked for a way to invite a friend with a reward for the inviter, and a bump in the waitlist for the friend. TD-15 says what a reward may be: earned, never bought, never transferable, in a ledger of its own (#85, which no slice had built yet). ADR-039 §7 had said that no reward adds a fish.

The maintainer decided on 22/10/2026, in chat:

1. The reward is configurable in `matching_config`: when somebody invited signs in with their bank and completes their profile, the inviter earns a reward whose kinds and amounts come from config, a fish (ADR-039) or extra likes or both. The default is one fish and no likes.
2. Earned likes are banked and used by themselves on a day the likes run out. Today `round_size` (10) equals `like_budget_balanced` (10), so the day's budget never binds and an earned like does nothing until he lowers the budget below the round; that is accepted. Earned fish are banked too and used by themselves once the rolling fish budget is spent.
3. An invitation counts the night the invited person first passes the gate's own completeness test (approved photos, current consents, identity standing ok: the first time a `gate` row exists for them), whether or not they are let in. Counted in a nightly batch, so the timing tells the inviter neither which friend it was nor that the friend waits in a contest's line.
4. The waitlist bump is dropped. Nothing in the pond or the gate changes.
5. The code is typed. Universal and app links wait for #184's native batch. The shared message carries `https://kuutti.app/` and a code; the app asks for the code in an optional step of onboarding after the consents, and on a screen of Settings.

The rest was set with the build (the points under "Open, the maintainer's").

## Decision

1. **What an invitation is.** A code for one friend, made by a person whose profile and onboarding are complete (ADR-060 §7, in place of a `gate` row). A shadow-banned person invites as anybody does, since a shadow ban never shows (ADR-024 §7); anybody else is answered 409 `invitation_not_yet`. The friend types the code after their bank login. The night the friend's profile first passes the same test, the invitation counts and the inviter earns what `invitation_reward` says that night (§4, §7). `GET /invitations` answers the caller's own (`Invitations`, `packages/schema/src/rewards.ts`): whether they may invite (`canInvite`) and still type a code (`redeemable`), what an invitation earns today (`reward`, for the app's words), their open invitations newest first (`open`, id and date), how many of theirs have counted (`counted`), and what those earned and is not used yet (`earned`). It never names or counts anybody invited, and has no state for an invitation redeemed but not counted, which would tell the inviter that one friend joined and has not finished.

2. **The code.** Ten characters of Crockford's base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, 50 bits) from the operating system's generator (`node:crypto`), drawn without modulo bias, and shown in two groups, `XXXXX-XXXXX`. What is typed is read as Crockford reads it: upper case, spaces and hyphens left out, `O` as zero, `I` and `L` as one. The format is a constant of `packages/schema` (`INVITATION_CODE_ALPHABET`, `INVITATION_CODE_LENGTH`, `INVITATION_CODE_PATTERN`, `normaliseInvitationCode`, `groupInvitationCode`), not a tunable, as `EMAIL_CODE_LENGTH` is. Only the SHA-256 of the normalised code is stored (`invitation.code_hash`, unique), never an HMAC with the hetu key, which is for the hetu alone (rule 2). Unlike ADR-043's code, the hash carries no account id: the redeemer does not know whose code it is, so the lookup is by the code alone. The code is shown once, in the answer that made it; it is in no row, log line, error, event or export.

3. **The records.** Migration 0079, generated:
   - `invitation(id, inviter_account_id, code_hash, created_at, redeemed_by_account_id, redeemed_at, counted_at)`: unique on `code_hash`; unique on `redeemed_by_account_id`, so a person redeems one invitation ever; an index on the inviter and the date. `invitation_redeemed_check` holds the three states: open is nothing set; redeemed is a time and a redeemer; counted is redeemed with `counted_at`, and a counted one may lose its redeemer to an erasure (§10). `inviter_account_id` is nullable: a redeemed invitation, counted or not, outlives its inviter's erasure with the link cut (§10). `invitation_named_check` keeps every row somebody's: an open one names its inviter, and one whose inviter is gone stays only while it names its redeemer. `invitation_not_self_check` refuses an invitation redeemed by its own inviter, and passes on an inviter cut to null.
   - `reward(id, account_id, kind, invitation_id, earned_at, spent_at, spent_entry_id)`, one row per unit, `reward_kind` `like | fish` (`RewardKind`). `invitation_id` cascades from the invitation; `spent_entry_id` points at the round entry the unit paid for and is set null when the entry goes, the time staying (`reward_spent_check`: a link only with a time). Indexes on the account and kind, on the invitation, and on the spent entry where there is one.
   - `notice.invitation_id`, cascading from the invitation, and the kind `invitation_counted`. Postgres refuses an enum value inside the transaction that adds it, and the migrator applies every pending migration in one transaction (an empty database's whole folder at once), so a second migration would not help. The check names the old kind instead, as 0056 and 0060 did:

     ```sql
     ALTER TABLE "notice" ADD CONSTRAINT "notice_invitation_check" CHECK (("notice"."kind" <> 'warning') = ("notice"."invitation_id" IS NOT NULL));
     ```

     With two kinds that reads "a counted invitation's notice, and only it, points at its invitation" beside `notice_warning_check`; whoever adds a third kind rewrites it.

4. **The tunables.** Migration 0080 (`generate --custom`) writes three version 1 rows, the seed's `MATCHING_CONFIG_V1` the same (`migrate.test.ts` keeps them equal):

   ```sql
   INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
     (1, 'invitation_reward', '{"fish": 1, "likes": 0}'::jsonb, 'migration:0080'),
     (1, 'invitations_open', '5'::jsonb, 'migration:0080'),
     (1, 'invitation_tries_per_day', '5'::jsonb, 'migration:0080')
   ON CONFLICT ("key", "version") DO NOTHING;
   ```

   `invitation_reward` is one object of numbers, so the panel's change keeps its two keys and whole numbers (#305), and 0 switches a kind off. Its reader parses it with `InvitationReward` (strict, whole numbers, 0 to 10 fish and 0 to 50 likes) and fails loudly, a 500 naming the key, as the photo fetch budget's reader does (`readPhotoFetchBudget`).

5. **Making and withdrawing.** `POST /invitations` answers 201 with `InvitationCreated`: the id, the code in its two groups and the time (`makeInvitation`, `apps/api/src/rewards/invitations.ts`). A person holds at most `invitations_open` (5) open invitations, and never more than the contract's ceiling of twenty (`INVITATIONS_OPEN_CAP`) whatever the panel sets, counted in the statement that inserts the new one under the account row's lock, as the feedback, the exports and the e-mail's sends are; one more is 409 `invitations_full`. `DELETE /invitations/{id}` deletes an open invitation of the caller's own (204); a redeemed one, another's or nobody's is 404 `not_found`. An account erased between the session guard and the work is 404 `not_found` on every route. Every statement names the caller's account (rule 6).

6. **Redeeming.** `POST /invitations/redeem` with `{ code }` (`InvitationRedeemRequest`: at most 32 characters as typed, which must read as a code; anything else is 400 `validation_failed` before anything is read). Under the caller's account row's lock:
   - **The caller first, before the code is looked up**, so the route answers nothing about a code to somebody who could not use it: their identity has never had an account erased (`identity.deletion_count = 0`), they have no `gate` row yet, they have redeemed no invitation, and they have given the current terms and privacy consents, as onboarding asks after `welcome`. Any of these fails: 409 `invitation_not_for_you`.
   - **Then the code.** Unknown, already redeemed, or the caller's own: one answer, 404 `invitation_unknown`, as ADR-027 §3 answers every sign-in code that does not work. A code that works records `redeemed_by_account_id` and `redeemed_at`, and the answer is 204.
   - **Tries.** A person may try `invitation_tries_per_day` (5) codes a Finnish day, whatever the answer, a malformed one's 400 included: the route's limiter keyed by the person, after the session guard and before the body is read, its window ending at midnight in Finland, as the chat's photo tries are counted (in memory, TD-3; a restart forgets them), and 429 `invitation_tries_exceeded` with `Retry-After`. Neither the code nor the limiter's key reaches a log line; the refusal's line names the limit.
   - `shortcut:` a person whose identity had an account erased can never be invited (`deletion_count = 0`), so a friend who left once and comes back cannot earn their inviter anything; a mark on the identity that it once redeemed would lift it, at the cost of keeping that mark through erasure, a retention change.

7. **Counting, at night.** A nightly job (`invitation-count`, `apps/api/src/jobs/invitation-count.ts`, in `boot.ts`), whose work is the rewards slice's (`countInvitations`), behind its `index.ts`. In one transaction: the inviters of what can be counted are locked first, in id order (`FOR SHARE`), since an erasure takes the account before its invitations and the count writes units that point at the account; then every invitation of theirs not counted, redeemed, whose redeemer is complete tonight (ADR-060 §7), gets `counted_at`; for each, its inviter gets one `reward` row per unit of `invitation_reward` as read then, and one notice of the kind `invitation_counted` (§9), even when tonight's reward is nothing. The gate is asked in SQL there, not through the pond slice's reader of one person's row, since the night asks it of every invitation in one statement. `counted_at IS NULL` makes a second run the same night write nothing. A reward of another shape fails the job, which writes nothing and is tried again the next night. Its log line carries counts only (`counted`, `fish`, `likes`). A shadow-banned invitee counts, since the gate counts them. Somebody suspended or banned before their profile passed the test gets no `gate` row while the sanction stands, so their invitation waits for the lift. A banned or suspended inviter still earns, a reward they cannot use while they cannot sign in. The demo's commands call the gate's `countGates` alone, so a demo reset counts no invitation.

8. **The ledger, and spending it.** A unit is used by itself, in `decide` (`apps/api/src/matching/rounds.ts`), under the round row's lock it already holds (ADR-034 §5):
   - **Likes.** The day's count of likes leaves out the likes a unit paid for. When it reaches `like_budget_balanced`, the like takes the person's oldest unspent earned like (`FOR UPDATE SKIP LOCKED`, one) and is written; with none, it is refused as before, 429 `like_budget_exceeded` (ADR-036 §4, amended by its §5).
   - **Fish.** The week's count of fish (ADR-039 §3) leaves out the fish a unit paid for: without that, a banked fish used today would fill the window and refuse the next window's own. When the count reaches `fish_budget`, the fish takes an earned fish; with none, 429 `fish_budget_exceeded` as before.
   - **Given back the same day.** A decision changed to a pass gives back every unit spent on its entry; a fish changed to a like gives back the fish's unit; a like made a fish keeps its like's unit. A unit spent stays spent when its entry goes later (an erased candidate, a future prune of the rounds): the link goes null, the time stays.
   - Likes and fish on a card that answers a like (`liked_you`, `fish`) stay free (ADR-036 §3, ADR-039 §2) and never spend a unit.
   - The SQL that reads or writes `reward` is the rewards slice's; the matching slice calls it through `apps/api/src/rewards/index.ts` (`spendEarned`, `releaseEarned`, `entriesPaidBy`, and `earnedFishWaiting`, which the round asks whether an earned fish waits, #475). A refusal later in the same decision, a fish refused after its like took an earned like, rolls the spend back with the rest.

9. **The inviter learns.** The notice `invitation_counted` (ADR-032, amended): "An invitation of yours counted", with what it earned, counted from the invitation's own units. `Notice` is a union by kind (`WarningNotice` with its `reason`, `InvitationCountedNotice` with its `reward`); `listNotices` reads the invitation's units beside the warning's sanction, and the filter that hides a lifted warning applies to warnings alone. It never names the person invited. No push, no badge and no counter (ADR-032 §4).

10. **Erasure and export** (ADR-007, amended). An erased inviter's units go by the account, every unit being its invitation's inviter's, and their notices with the notices' own step; of the invitations they made, the open ones go, and a redeemed one, counted or not, stays for its redeemer with `inviter_account_id` cut to null. The redeemer has still redeemed one invitation, ever (§3): they cannot type another code, Settings does not offer the field again (which would tell them their inviter left), and their export keeps `used`. The night never counts an invitation whose inviter is gone, since its lock and its update name live inviters only, so nobody earns from it. An erased redeemer's invitation goes if it has not counted; a counted one keeps its count without the person (`redeemed_by_account_id` null, `redeemed_at` kept), and the inviter keeps what it earned (`eraseInvitationsOf`, after the notices). A row that would name nobody goes, whoever of the two is erased second. Nothing cascades from an invitation deleted to anybody else's row: its units and its notice are its inviter's. `ErasureSummary` counts each side, what went and what stayed: `madeInvitationsDeleted`, `madeInvitationsKept`, `rewardUnits`, `usedInvitationsDeleted` and `usedInvitationsKept`. The export carries the invitations the person made (when, `open | redeemed | counted`, when it counted), the one they joined with (when they typed it, when it counted), and their units (kind, earned, spent): never a code and never the other person (`ExportedInvitations`).

11. **What is recorded nowhere else.** No research event: one at the invitee's count would put the inviter's and the invitee's pseudonyms in one night's link (ADR-011 §9). Nothing in the moderation panel. The log lines of the routes name the caller's account, never a code; the night's names nobody.

12. **In the app** (`apps/mobile/src/features/rewards`). Settings › Invitations (`/settings/invite`, a row under Account) says what an invitation earns from `reward`, a whole sentence for the kinds there are (a fish, extra likes, both, or nothing when both are 0); Make an invitation shows the code just made, large, selectable and read to a screen reader a character at a time, with the line that it is shown only now, and Share the code, which hands the phone's share sheet a message saying that Kuutti is free, bank-verified and Finland's, with `https://kuutti.app/` and the code, and nothing about the sender, until a read of the list that once had it has it no more (a friend used it, or it was withdrawn); the open invitations by when they were made, each withdrawn after a dialog; how many counted, and what waits to be used. A person who may not invite reads that invitations open once the profile is complete; one who may still type a code finds its field there. Use the code stays dimmed until what is typed reads as a code by the schema's normaliser, so a slip spends none of the day's tries. Onboarding offers the same field once a walk, right after the welcome's consents (which `redeemable` needs) and while the name is still to come, when `GET /invitations` says `redeemable`, with Skip; it counts no number in "Step x of n", as the welcome step counts none since #418 (ADR-010 §15), a walk resumed further on is not interrupted by it, and a read that fails passes it over, so it never holds onboarding up. The notice `invitation_counted` reads "Somebody you invited has finished their profile" with what it earned.

## Consequences

- With today's numbers an earned like is never used: the round holds ten cards and the day ten likes (the maintainer accepted it, Context 2). It starts to matter the day he lowers `like_budget_balanced` below `round_size`.
- A banked fish is a fish beyond the window's, used once the window's own is spent, and it reaches its person first as any fish does (ADR-039 §4).
- What the inviter can still work out: an open invitation leaves the list when it is redeemed, and `counted` rises at a later night. With one invitation open, they know that it was used, which they would know from their friend anyway; the night's batch keeps the moment of the friend's finished profile, and whether the friend was let in or waits, from them. The export's `redeemed` says what the list already says.
- The database links an inviter and the friend who used their code (`redeemed_by_account_id`) for as long as both accounts stand: who invited whom is personal data of both, in both exports (each sees only their own side). The privacy summary does not name it yet (Open 3).
- A reader of the table holds each code's SHA-256. Fifty bits are many guesses, but not too many for somebody with the hash and a graphics card. What they would gain is the use of an open invitation, earning its inviter a fish; one who can write the table can do that anyway.
- Guessing through the route: five tries a person a day, each against every open code at once. With five thousand people holding five open codes each, a try finds one with a chance of about 2 in 10^11, and every try is a bank-verified person's.
- A friend who signs up before getting the code may still type it until their profile passes the test: onboarding offers it once after the consents, Settings after that.
- Farming: every counted invitation is a different bank-verified person with an approved photo and a complete profile, so a reward costs a real person's onboarding. `invitations_open` bounds the codes held at once, not the invitations of a lifetime.

## Alternatives considered

- **A link that opens the app with the code:** needs #184's universal and app links. A typed code works on every phone and on the web preview.
- **Counting at the redeem:** a code typed and abandoned would earn a fish, and the moment would tell the inviter who it was.
- **Counting at admission, or when the round opens:** the night the friend was let in tells the inviter whether the friend waited in a contest's line (Context 3).
- **The waitlist bump for the friend:** dropped by the maintainer (Context 4); the gate's order stays everybody's.
- **A per-invitation state in the app** ("used, not finished"): it names a friend's progress to the inviter.
- **Storing the code, or an HMAC with the hetu key:** the first is readable in every read of the row; the second spends a key that is for the hetu alone (rule 2).
- **A balance column on the account instead of a row per unit:** the give-back needs to know which entry a unit paid for, and the export which units were used when.
- **Two migrations for the enum value and its check:** the migrator applies an empty database's whole folder in one transaction, so the second would still meet the uncommitted value (§3).

## Not built

- The waitlist bump (Context 4).
- Universal and app links for an invitation (#184).
- A research event (§11).
- The invitations in the moderation panel.
- Earning by finishing one's own profile, and the explicit "five more likes" of #85; #85 stays open for both.
- The privacy summary's words on invitations: the summary is a draft that #190 finalises for the beta (Open 3).

## Open, the maintainer's

1. `invitations_open` (5) and `invitation_tries_per_day` (5): the build's numbers; a new one is a new version in the panel.
2. Lowering `like_budget_balanced` below `round_size`, the day earned likes should do something (Context 2).
3. The privacy summary's line on invitations, and who invited whom kept while both accounts stand (#190).
4. The identity-level mark that would let a person who left once be invited again (§6's `shortcut:`).
5. Whether the link between inviter and friend should be cut once the invitation counts; it keeps the friend's export of when they joined, and the rule that a person redeems once.
6. The words in the three languages, the share message's included, with the native review.

## History

- 2026-10-22: written with #107's build, on the maintainer's decisions of that day. ADR-007, ADR-032, ADR-036 and ADR-039 are amended the same day.
- 2026-10-22: the build's review found that an inviter's erasure deleted the invitations their friends had redeemed, so a friend who had not finished could type a second code, read the code field in Settings again, and lost `used` from the export. A redeemed invitation now stays for its redeemer with the inviter cut to null, never counting, and a row naming nobody goes (§3, §10); migration 0079, not yet on `main`, was generated again with the nullable column and `invitation_named_check`. The same review found that the code just made outlived its code in Settings when a friend used it while the screen was open; it now goes once a read that listed it lists it no more (§12).
- 2026-10-22 (#418): §12's code in onboarding counts no step. The consents moved before the bank login and the welcome step became the fallback with no number (ADR-010 §15), so the code, offered once before the name and never required, has no number to share; the walk counts eight steps from the name.
- 2026-10-29 (#475): §8 names `earnedFishWaiting`, the read the round's `fishToSend` makes (ADR-039 §6); the fish's window is the calendar week since #475 (ADR-039 §3), no longer rolling.
