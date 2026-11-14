# Phase 7: the phone app

About 24,000 source lines and 52,000 test lines. Target: about 2,500 fewer lines of code, on top of the comment sweep of phase 5. Nothing a person sees changes: same screens, same texts, same accessibility labels, roles and 44 pt targets.

Line numbers are from the audit and "reported". Four big screens were only skimmed (`ProfileCardView.tsx`, `PhotosScreen.tsx`, `FieldEditor.tsx`, `SettingsScreen.tsx`): read them before estimating.

## How it is built today

- Navigation: expo-router routes in `app/`, each a thin file. `app/_layout.tsx` nests 7 providers.
- State: `useState` and `useRef` per screen, 7 contexts, and 16 module-level `let` variables (`lib/session.ts`, `chat/notice.ts`, `profile/client.ts`, `notifications/phone.ts`).
- Data: `openapi-fetch` with an auth middleware in `lib/api.ts`; one `client.ts` per feature with zod parsing. There is no query library, so every screen writes its own loading, error and refresh handling.
- Live: one WebSocket (`chat/socket.ts`) feeding a reducer (`chat/store.tsx`). All writes go over HTTP.

The root cause of most of the bulk is the missing shared way to read data. We do not add a library. One small hook covers it.

## Steps

### [ ] 7.1 Pilot: one `useRead` hook

- **Today:** "read on focus, newest answer wins, keep the old data on a quiet failure" is written 15 times, each with its own `mounted` ref (25 files), its own request counter and its own status names (`failed`, `error`, `unavailable`):
  `pond/useGate.ts`, `pond/usePondCounter.ts`, `rewards/useInvitations.ts`, `matching/useStars.ts`, `chat/useConversations.ts:100-151`, `profile/seek/useSeeking.ts`, `profile/gender/useOwnGender.ts`, `identity/onboarding/useOnboarding.ts`, `useOnboardingGate.ts`, `lib/row-data.ts`, `identity/EmailCard.tsx:103-125`, `chat/YourContacts.tsx:63-89`, `profile/useProfile.ts:147-170`, `media/usePhotos.ts:64-75`, `profile/CardPreviewScreen.tsx`.
- **Change:** `useRead(fetcher, { onFocus, onForeground })` in `src/lib/`, about 45 lines, returning `{ status, data, error, reload }`.
- **Pilot on three:** `pond/useGate.ts`, `rewards/useInvitations.ts`, `matching/useStars.ts`. Measure. Then the rest.
- **Fixes on the way:** `useOnboarding.reload` (`:33-42`) has no newest-wins guard, unlike its siblings. `photosHeld` and `seeksHeld` in `OnboardingScreen` are workarounds for that and can go.
- **Target:** about −300, more once the screens use it.

### [ ] 7.2 One send helper

- **Today:** each screen keeps its own `busy`, `failed` and refusal-text state around a write. There are 8 per-screen maps from an error code to a text key (`REFUSALS`).
- **Change:** `useSend(action)` returning `{ send, busy, refusal }`, like the panel's `features/safety/use-send.ts`. One shared map for the codes several screens know; a screen adds only its own.
- **Target:** about −250.

### [ ] 7.3 Less boilerplate in the clients

- **Today:** `if (!data) throw failed(...); return X.parse(data)` appears 62 times in 11 `client.ts` files (about 1,050 lines).
- **Change:** `call(api.GET(...), "what", Schema)` in `lib/api.ts`.
- **Target:** about −160.

### [ ] 7.4 One way to get a fresh session

- **Today:** "use the token, refresh once on an auth failure" is written three times: `lib/api.ts:60-82`, `media/client.ts:173-208` (for XHR uploads), `chat/socket.ts:135-150`.
- **Change:** one `freshSession()` in `lib/session.ts`. One place to get refresh races right.
- **Target:** about −30, and one place for the next bug.

### [ ] 7.5 Use the shared components that exist

- Radio groups are rebuilt although `components/Choice.tsx` exists: `safety/SafetyActions.tsx:503-516, 629-692`, `media/CaptionDialog.tsx:42-62`, `chat/CountryPicker.tsx`. About −60.
- 17 inline loading lines beside `LoadingScreen`. About −30.
- `lib/decision-buttons.tsx:48-78` and `lib/photo-descriptions.tsx:52-82` are the same provider with a different key and parser. One `createStoredSetting(key, read)`. About −35.

### [ ] 7.6 Remove scaffolding for a feature that does not exist

- **Where:** `media/localCheck.ts`
- **Today:** `setLocalCheck` is called only from tests, so the on-device photo check always allows, and 7 `refused_local` branches cannot run.
- **Change:** delete until the native classifier exists. About 60 source lines plus tests.
- **Owner's call:** the README names it as waiting for #184.

### [ ] 7.7 Rebuild the big screens on the helpers

Do after 7.1 to 7.5. Each screen is one pull request. The component tests of the screen must pass unchanged; that is the proof nothing visible moved.

| Screen | Now | Jobs inside | Split into | After |
|---|---|---|---|---|
| `chat/ConversationScreen.tsx` | 859 | load, merge and page; reconcile detail and contacts by request number; mark read; apply socket frames; composer state with send, retry and idempotency; photo attach; photo URL re-read; screen-reader announcements; render | `useConversation(id)` for data, socket and mark-read (about 220); `useComposer(id, onSent)` (about 110); `MessageList.tsx` (about 100); `Composer.tsx` (about 80); the screen (about 180) | about 690 |
| `safety/SafetyActions.tsx` | 764 | three entry buttons; the step machine; request, outcome and announce logic; five step screens | `useSafetyFlow` (about 90); `ReportStep` using `Choice` (about 110); one `ConfirmStep` for block and unmatch (about 40); `DoneStep` (about 25); three thin entries (about 120) | about 430 |
| `identity/onboarding/OnboardingScreen.tsx` | 612 | step resolver; local holds; the invitation probe; ten step screens inline | `nextStep.ts` (about 60); one file per step under `onboarding/steps/` (25 to 40 each); the screen as a switch (about 150) | about 520 |
| `matching/useRound.ts` + `RoundScreen.tsx` | 513 + 522 | read first | read first | |
| `identity/lock/LockProvider.tsx` | 436 | the lock state machine; the privacy cover; biometrics probing; passcode tries; the unrelated `useLockOfferDue` / `markLockOffered` (`:418-436`) | move the offer helpers out; read the rest first | |
| `identity/session.tsx` | | `SessionProvider` carries export, delete and pause (`:176-216`) | plain functions in a client file | |

### [ ] 7.8 Module-level state

Sixteen `let` variables hold state outside React. List each, and for each decide: it is a cache (`useRead` now covers it), it is a singleton that must outlive screens (keep, with one line saying why), or it is a leftover (delete).

### [ ] 7.9 Then the tests (phase 4.4)

Rewrite each rebuilt screen's tests once: one per state a person can see, one per accessibility rule, and the hook's logic once in the hook's test.

## Not in this phase

- Adding a query library. `useRead` gets most of the benefit with no new dependency.
- The neubrutalism theme try (the Dusk and Birch palettes, chosen on the tech screen and never in production). It is extra tokens and classes for an experiment; whether to keep it is the maintainer's.
- `plugins/`, `theme/`, `components/ui/*`: not read by the audit.

## Check for the phase

- `pnpm --filter @kuutti/mobile test` and `typecheck`.
- `pnpm e2e` on a simulator once per rebuilt screen.
- Each changed screen looked at running, in both themes, at the largest text size, with the screen reader walk the project already requires.
