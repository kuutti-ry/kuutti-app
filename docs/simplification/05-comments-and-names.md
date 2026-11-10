# Phase 5: comments and names

Mechanical, no behaviour change. It makes the code readable before anyone restructures it. Needs phase 1 (the new comment rule) so the comments do not grow back.

## Comments

### Where we are

About 16,300 comment lines, 18% of source. 3,390 lines cite an ADR, a TD or an issue number. Share by file:

| File | Comment share |
|---|---|
| `apps/mobile/src/features/chat/notice.ts` | 38% |
| `apps/api/src/lib/config.ts`, `lib/rate-limit.ts` | 34% |
| `apps/api/scripts/demo/reset.ts` | 34% (60-line header) |
| `apps/api/src/chat/conversations.ts` | 27% |
| `apps/api/src/boot.ts` | 26% |
| `apps/api/src/identity/login.ts`, `app-attest.ts`, `matching/rounds.ts`, `media/moderation.ts`, `apps/mobile/.../useRound.ts` | 23–25% |
| `packages/schema/src/*` | 20–43% |

### The rule

A comment says why, in one sentence, when the code cannot show it.

| Kind | Example today | Do |
|---|---|---|
| Says what the code does | "The person's likes of the day against the budget" above `likesSent` | Delete. The name says it. |
| Cites instead of explaining | `// TD-11`, "(#324, ADR-026 §8)" | Write the reason in one sentence. The number may follow in brackets. |
| History | "the maintainer's of 20/10/2026", "#98's first cut" | Delete. Git and the ADR hold history. |
| Header block retelling the feature | 30 lines at `ConversationScreen.tsx:131-162`, 44 at `identity/erasure.ts:51-94` | At most five lines: what this file is for and the one thing that will surprise a reader. |
| A real "why" | "taken after the decider's round lock, never before, so no two wait for each other" | Keep. This is what comments are for. |
| Repeated note | "A 403 is the shell's to say (#302)" in about ten panel files | Say it once, where the shell handles it. |
| `shortcut:` | any | Keep as it is. |

Security and privacy "why" comments stay, shortened: why a query is scoped, why a value never reaches a log.

### Steps

One pull request per slice, comments only, so the diff is easy to review: nothing but comment lines changes.

- [ ] `apps/api/src/identity`
- [ ] `apps/api/src/chat`
- [ ] `apps/api/src/media`
- [ ] `apps/api/src/matching` and `jobs`
- [ ] `apps/api/src/safety`
- [ ] `apps/api/src` the rest: `lib`, `notifications`, `profile`, `pond`, `rewards`, `research`, `app.ts`, `boot.ts`
- [ ] `apps/mobile/src/features/chat`, `identity`
- [ ] `apps/mobile/src/features` the rest, `lib`, `components`
- [ ] `apps/admin/src`
- [ ] `packages/schema`, `packages/db`, `packages/i18n`
- [ ] `scripts`, `apps/api/scripts`

Check for each: `git diff --stat` shows only removed and changed comment lines; `pnpm typecheck` and `pnpm lint` pass.

Route descriptions inside `createRoute` are not comments. They end up in `openapi.json`. Leave them for phase 6 (decision D6).

Target: about 16,300 to about 6,000 lines.

## Names

Rename only inside the code. Stored names (columns, config keys), contract names and anything in `openapi.json` stay.

Do names after comments, one slice per pull request, with the editor's rename so every use moves together.

### API: identity and lib

| Now | Plain name |
|---|---|
| `doors` | `signInStartLimit` |
| `whenFull` | `redirectIfTableFull` |
| `unasserted` | `attestationOff` |
| `keyless` | `missingAssertion` |
| `KEPT_MS` | `HEALTH_CACHE_MS` |
| `attemptGone` | `unknownState` |
| `settle` / `Settled` / `settleAll` | `stateFromSanctions` / `recomputeAccountStates` |
| `sessionStore.standing` | `sessionStatus` (it collides with the identity's `standing`) |

The log line "sign-in refused" at `identity/login.ts:90` is written for a start that goes ahead. Fix the text.

### API: chat, media, notifications

| Now | Plain name |
|---|---|
| `opened` / `pushed` / `fetched` (callbacks) | `onFirstMessage` / `onMessageSent` / `onPhotoUrlIssued` |
| `holdWithheldMarksOf` | `rollBackHiddenReadMarks` |
| `closerLines` | `stricterThresholds` |
| `noted` | `strikeGroup` |
| `leaveArchive` | `unarchive` |
| `keepContact` | `saveContact` |
| `present` | `signOwnMessage` |
| `refused` | `handleTicketError` |
| `timing` | `quietHoursAndTtl` |
| `Live` / `hub` | `ChatSockets` / `fanOut` |
| `seen` (in moderation) | `descriptionSignals` |

### API: matching, jobs, safety

| Now | Plain name |
|---|---|
| `Place` / `addPlaces` | `QueuedCard` / `appendCards` |
| `Subject` / `FACTS` | `CompletePerson` / `PERSON_SQL` |
| `todayOf` / `Today` | `loadQueueContext` |
| `heldBack` / `notHeld` / `atTheStop` | `overInboxLimit` and its negation |
| `waitingOn` | `unansweredLikesTo` |
| `SERVABLE` | `CANDIDATE_ACTIVE_UNBLOCKED` |
| `PLACES` | `LAST_POSITION_SQL` |
| `underRuleLock` | `runAutoBanCheck` |

`fish` stays: it is the product's word and is in the glossary.

### Phone app

| Now | Plain name |
|---|---|
| `useHandToList` | `useReturnToChatList` |
| `Held` / `begun` / `told` / `marked` (`ConversationScreen`) | `latest` / `requestSeq` / `lastSeenSignals` / `readUpTo` |
| `withLive` (two different functions, `ConversationScreen:115`, `useConversations:45`) | two different names |
| `report` meaning "report cursors" (`:201`) and "abuse report" (`:695`) | `reportCursors`; keep `report` for abuse |
| `door` (`ChatPhotoScreen:82`) | `reportableSeq` |
| `settle="dialog" \| "screen"` | `outcomeShownIn` |
| `More` / `freshen` (`useRound`) | `NextPage` / `reloadIfNewDay` |
| `inLine` (`profile/client.ts`) | `queued` |

`RoundNotice` lists `"load.failed.press"` three times (`useRound.ts:62-66`). Remove the repeats.

### Panel and tooling

| Now | Plain name |
|---|---|
| `onShell` | `onForbidden` |
| `settle` | `decrementTotal` |
| `Refusals` | `ErrorMessages` |
| `viaRoutes` / `viaServices` | `httpWriter` / `directWriter` (one goes in phase 3) |
| `owed` | `missingLicenceTexts` |
| `whoIs` | `identityFilterSql` |

### The `jobs/` folder

`apps/api/src/jobs/` holds `round-builder.ts`, `pool.ts` and `stars.ts`, which run on requests, not at night. Renaming or moving the folder touches the slice layout: see D9 in phase 6.
