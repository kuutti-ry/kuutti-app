# Phase 6: the API

The API is about 30,000 lines, 22,400 of them code. Target: about 17,000 lines of code. No route, answer, table or behaviour changes.

Line numbers are from the audit and mostly "reported": read before changing. Do phases 3 to 5 first so the files are smaller and readable.

## How to work

1. **Pilot first.** Steps 6.1 and 6.2 are patterns applied to every slice. Do each on one small slice (`rewards`, 943 lines, or `pond`, 801) and measure the lines saved. If the saving is under a quarter of the file, stop and rethink before rolling out.
2. One pull request per step per slice.
3. Tests stay green without edits wherever the step is a pure refactor. A test that must change is a sign the step changed behaviour: stop and look.

## Patterns for every slice

### [ ] 6.1 One route helper

- **Today:** 24 route files, 4,972 lines, 108 routes: 46 lines per route. Each file redefines `errorContent`, `json` and `bearer` (24 copies, about 78 lines). Each route spells out its auth, its error answers and its JSON wrapper.
- **Change:** one helper in `apps/api/src/lib/` that takes the method, path, guard, request schema and response schema, and fills in the security scheme and the standard error answers. A route becomes its contract plus its handler.
- **Also:** `Retry-After` is set by hand from `error.detail` in at least six places (`identity/account-routes.ts:276-287, 320-337`, `matching/round-routes.ts:223, 244, 276`, `matching/star-routes.ts:145`). Set it once in `onError`.
- **Needs D6** only for the part that shortens route descriptions. The helper itself must produce the same `openapi.json`: run `pnpm openapi` and expect no diff.
- **Target:** about 25 lines per route, about −2,000.

### [ ] 6.2 Typed queries, no row mappers

- **Today:** about 495 raw SQL calls. Results are untyped rows mapped by hand with casts (191 `as string` / `as number` / `as Date` in the API). Examples: `chat/repo.ts:133-161, 260-278`, `media/repo.ts` `photoFrom` and `reviewItemFrom`, `notifications/repo.ts` `textsOf` and `announcementOf`.
- **Change:** name the columns in the SQL (`AS "openedAt"`) and type the call (`db.query<Conversation>`). The mapper functions and casts go.
- **Do not** introduce the Drizzle query builder. The rule that asked for it is corrected in phase 1.
- **Target:** about −800.

### [ ] 6.3 Less wiring

- **Clock:** `Deps.now` is optional and never set in production. There are 27 `now ?? (() => new Date())` fallbacks in three spellings, and three route files ignore it and read the wall clock (`identity/routes.ts:278`, `account-routes.ts:314`, `onboarding-routes.ts:116`). Make `now` required, set once in `createApp`.
- **Deps types:** `{db, logger, now}` is declared again as `RoundDeps`, `BuilderDeps`, `RuleDeps`, `ResearchDeps`, `ChatDeps`, `ArchiveDeps`, `PhotoServiceDeps`, `ModerationDeps`, `PushDeps`, `SocketDeps` and more. One `Deps` type; a function takes it or takes the two things it needs.
- **Interfaces with one implementation:** `SessionStore` and `AdminSessionStore` (`lib/*-middleware.ts`, `identity/session-store.ts`, `admin-session.ts:121-137`) exist so `lib/` does not import the slice. Move both guards into `identity/` and delete the interfaces. `moderator?` in `MediaDeps` is optional only for tests: make it required.
- **Pass-through files and functions:** `rewards/ledger.ts` (46 lines, only forwards to `repo.ts`); in `chat/conversations.ts` `lockReportedConversation`, `copyConversation`, `conversationsOnTurn`; in `media/photos.ts` `countMessagePhotosSince`, `toPhoto`; in `notifications` `recordWarningNotice`, `recordInvitationNotices`, `eraseNotificationsOf`; `media/erasure.ts` `eraseReleasedPhotos`. Export the real function from the slice's `index.ts`.
- **`media/wiring.ts:76-125`:** two branches that differ only in the signer.
- **Target:** about −600.

### [ ] 6.4 The callbacks through `app.ts` (needs D9)

- **Today:** `Queue`, `Matches`, `ShortPool` and `Stars` (`matching/rounds.ts:54-85, 769-779`, `jobs/stars.ts:46`) are interfaces with one implementation each, wired by about 15 closures in `app.ts:382-428`. `roundRoutes` takes 8 positional arguments. This exists because the queue builder lives in `jobs/`, outside `matching/`, and the import rule forbids matching reaching into it.
- **Change:** move `jobs/round-builder.ts`, `jobs/pool.ts` and `jobs/stars.ts` into `matching/`. Matching then calls them directly; chat's and notifications' functions are imported from their `index.ts`. `app.ts` (461 lines) shrinks to middleware, guards and mounting.
- **This moves a boundary**, so it is the maintainer's decision. Without it, skip this step; the rest of the phase still stands.
- **Target:** about −300.

## One copy of each rule

### [ ] 6.5 Chat

- The sequence "hold the account, lock the conversation, read the state, 404 if hidden, resend check, closed check" is written five times: `chat/messages.ts:116-127`, `photos.ts:137-147, 179-189`, `contacts.ts:138-143`, `conversations.ts:267-270`. One `lockForWrite(tx, accountId, conversationId)` that throws. About −140.
- Two styles of refusal (an outcome union switched after the transaction, and throwing `AppError` inside it). Pick throwing.
- The `message_sent` tracking block is twice (`messages.ts:165-180`, `photos.ts:108-122`).
- `announcePresence` and `resume` (`chat/live.ts:164-232`) run the full conversation list query to learn two columns. Give them a two-column query.

### [ ] 6.6 Media

- `moderatePhoto` and `checkMessagePhoto` are the same 45 lines twice (`media/moderation.ts:455-532, 571-632`). `UNCHECKED` (`:548-556`) repeats `queueAllModerator().inspect()` (`:378-393`). One inspect-and-decide function. About −60.
- "Sign, count the budget, log" is twice: `photos.ts:460-526` and `:539-577`. "Put three variants, drop orphans" is twice: `:89-108`, `:266-276`. About −45.
- Hand-written PNG, JPEG and WebP header parsers (`media/pipeline.ts:21-98`) run just before `sharp(...).metadata()`, which reads the same header. Delete them and check `metadata.format`. About −75 plus tests.
- Finnish-day maths is in `lib/finnish-day.ts` and again in `media/budget.ts:57-110`. Move `dayWindow` to `lib/`. About −40. `DAY_MS` is defined in 12 files; `addDays` again in `safety/sanctions.ts:119`.

### [ ] 6.7 Matching and safety

- The insert block of `addPlaces` and `appendRelaxed` (`matching/rounds.ts:285-318, 864-899`). About −40.
- The "active and not blocked" rule lives in `SERVABLE` and is repeated inline at `rounds.ts:294` and `:867`, and in JavaScript in `jobs/pool.ts:224` and `matching/pool.ts:108`. Use `SERVABLE` in the inline copies.
- Shadow-banned candidates are filtered by `buildCard` and `SERVABLE` but not by `fitsNow`; `starsShown` adds its own filter (`jobs/stars.ts:38`). Filter once inside `fittingNow`, so a new caller cannot leak.
- Three variants of the "unanswered like" SQL (`jobs/round-builder.ts:189, 345, 590`). `relaxedPlaces` and `relaxedCandidates` (`:480-498`, `:681-699`).
- `recordReport` and `recordConversationReport` share their first 20 lines (`safety/reports.ts:83-101, 195-225`).
- `safety/automatic.ts:28-46`: 13 `_KEY` constants for strings used once or twice. Inline them.
- `matchingConfigNumber` reads one key per query; `matchingConfigNumbers` exists. `decide` reads the like and fish config twice (`rounds.ts:611/622`, then `budgetsOf` at `:699`).

### [ ] 6.8 Identity and lib

- "Session is alive" is written three times: `lib/auth-middleware.ts` (`LIVE_STATES`), `identity/repo.ts:520-523` (`SESSION_ALIVE`), `:457-461`. One SQL fragment.
- The two guards repeat bearer parsing, the token pattern and the admit-then-limit step. One `bearerToken()` helper.
- The erasure summary is built twice (`identity/erasure.ts:106-159` type, `:221-240` result, `:249-280` remap). Return the flat object. About −45.
- `lib/config.ts`: "development or test" is spelled 6 times here and 11 across the API; the `MAIL` and `PUSH` blocks are copies (`:356-375`). One `local` constant and one helper. About −40.
- Promise-with-timeout in `lib/db.ts` and `health/index.ts:21-35`. One.
- Redaction keys listed twice by hand in `lib/logger.ts`.
- `research/track.ts` `ageAt` repeats `profile` `ageInYears`.

## Code for cases that do not happen at this size

### [ ] 6.9 Sign-in table eviction (needs D8, ADR-026 §6)

- **Where:** `identity/repo.ts:97-155`, `login.ts:54-93`, `routes.ts:331-337`, `codes.ts:10-19`
- **Today:** about 110 source and 220 test lines evict the oldest sign-in attempts when the table is full. The table is already limited to 10 starts a minute per address with a 10-minute expiry, and it protects about 12 MB of disk.
- **Change:** delete expired rows and insert plainly on each start.

### [ ] 6.10 Push batching

- **Where:** `notifications/push.ts:249-269, 304-329`
- **Today:** a loop over 100-token chunks with a 200 ms pause runs per account, so it only repeats if one account has over 100 live sessions. A 20-line recursive retry handles tokens from another Expo project. `project`, `pause` and `schedule` exist only for tests.
- **Change:** send one request per account. About −45.

## Faster reads (same behaviour)

### [ ] 6.11 Read the viewer once per request

- **Where:** `matching/rounds.ts:357-383` calling `profile/card.ts:123-191`
- **Today:** each card re-reads the viewer's profile, home rules, card budget config and preferences: about 7 statements per card, about 100 for a first page.
- **Change:** read the viewer and config once and pass them in.

### [ ] 6.12 Sign conversation thumbs in one go

- **Where:** `chat/conversations.ts:154-160`, `media/photos.ts:539-577`
- **Today:** per conversation: a photo lookup, a config read, a transaction with an advisory lock, an insert, a log line. Fifty conversations is about 300 round trips.
- **Change:** read the budget once per request; insert the fetch-log rows in one statement.

## Split what is left, by job

Only after the steps above. A file is split when two jobs remain in it, never to make it shorter.

| File | Now | Jobs | After |
|---|---|---|---|
| `identity/repo.ts` | 1,398 | sign-in attempts; identity and account rows; sessions (both kinds); e-mail; consents and exports | five files, about 900 in all |
| `chat/repo.ts` | 1,251 | reads and send; close, erase and archive; contacts SQL moves into `contacts.ts`, its only caller; export and report copy beside their callers | about 950 |
| `matching/rounds.ts` | 1,140 | budgets; the queue; `decide`; relaxations; prune, erase and export | five files, about 870 |
| `media/repo.ts` | 1,010 | photo rows; access log and budget; review queue | three files, about 750 |
| `media/moderation.ts` | 711 | the Rekognition adapter; the pure decision; orchestration and the two nightly jobs | three files, about 510 |
| `jobs/round-builder.ts` | 700 | cooldown history; inbox and its limit; fill; fits; short pool | five files, about 590 |
| `identity/erasure.ts` | 514 | erasure (about 110 after 6.8); export assembly moves to `export.ts` | two jobs, two files |
| `safety/sanctions.ts` | 512 | apply, lift and review; reads for the panel, export and erasure | about 420 |
| `identity/routes.ts` | 501 | member sign-in; the five staff routes move beside `admin-session.ts` | about 330 + 170 |

## Not in this phase

- **App Attest** (`identity/app-attest.ts`, 415 lines of hand-written CBOR and DER parsing). The rules file itself says a client skips it by claiming to be Android. Whether it earns its place is a product decision (ADR-069).
- **OpenAPI prose.** About half of `chat/routes.ts` is description text. Shortening it changes `openapi.json` text, not types: D6.
- **The visibility rules in `chat/repo.ts`.** "Nobody can tell a block or a shadow ban from an unmatch" is a product rule and is where most of that file's SQL complexity comes from. It stays.

## Check for the phase

- `pnpm openapi` produces no diff (except description text, if D6 is given).
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm knip`.
- `pnpm e2e` and `pnpm e2e:admin` once at the end of the phase.
- `git grep -cE '\.query(<|\()' -- apps/api/src` and the comment and line counts, noted in the last pull request against the targets in `README.md`.
