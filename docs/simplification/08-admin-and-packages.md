# Phase 8: the moderation panel and the packages

The panel is about 5,200 source lines and 11,000 test lines. The packages are about 15,600. Target: about 1,500 fewer lines of code. Nothing a moderator sees changes.

Line numbers are from the audit and "reported": read before changing.

## The panel (`apps/admin/src`)

It is the healthiest part of the repo: comments are 5–12% and the shared pieces exist. The work is making pages use them.

### [ ] 8.1 One load hook for every page

- **Today:** `lib/use-list.ts` only fits `{ items, total }`. Four pages fake a total to use it (`Announcements.tsx:94-101`, `ConfigList.tsx:101-108`, `MatchingSwitch`, `StaffList`). Four more write loading, error, forbidden and newest-wins by hand (`ReportPage.tsx:69-104`, `AccountPage.tsx:97-155`, `Overview.tsx`, `AuditLog.tsx:64-115`).
- **Change:** generalise to `useLoad<T>`; `useList` becomes a thin use of it or goes.
- **Check on the way:** `ReportPage` and `AccountPage` have no newest-wins guard. Going back and forward between two ids may show one person's data under the other's title. Confirm, and add a test either way.
- **Constraint to keep:** opening a report or a person's page writes an audit row, so those pages fetch once per visit and never re-read. `useLoad` must not refetch on its own.
- **Target:** about −80.

### [ ] 8.2 One confirm step

- **Today:** written six times, each a dialog plus an effect plus a refusal alert plus confirm and cancel around `useSend`: `ReportPage.tsx:429-473` (DecideStep), `Sanctions.tsx:424-455` (LiftStep), `Announcements.tsx:345-439` (Approve, Delete), `MatchingSwitch` (TurnStep), `TakeDown.tsx`.
- **Change:** one `ConfirmStep` taking the title, the effect in words, the fields and the action.
- **Also:** `PhotoQueue` rows, `FeedbackList` rows and `ConfigList.tsx:188-212` keep their own saving and failed state instead of `useSend`. Use it.
- **Target:** about −120.

### [ ] 8.3 One "show photo" component

- **Today:** written four times: `ReportPage.tsx:515-557` and `:567-629`, `AccountPage.tsx:369-427`, `PhotoQueue.tsx:85-98` (which ignores `usePhotoOnRequest`).
- **Bug inside:** the copy at `AccountPage.tsx:405-413` lost `aria-describedby`, so a screen reader hears several identical "Show photo" buttons. The shared component fixes it.
- **Combine with bug B5:** the shared component reports whether the photo is on screen, and Approve reads that.
- **Target:** about −80.

### [ ] 8.4 Small duplicates

- `Sanctions.tsx:40-79` and `report-words.ts` hold four maps that only spell `admin.sanction.<x>.${kind}`. `Announcements.tsx:119` already uses a template key. About −40.
- The status line `<p ref={status} role="status" tabIndex={-1} …>` appears five times. One component.
- `ReportQueue` and `AutomaticBans.tsx:104-107` hand-write `RefreshButton`.
- `ConfigList.tsx:314` hard-codes `500` where `CONFIG_REASON_MAX` exists.

### [ ] 8.5 Split the two biggest pages, if two jobs remain

After 8.1 to 8.3, look again at `ReportPage.tsx` (629) and `Sanctions.tsx` (594). Split only if a file still does two jobs.

## `packages/schema`

The contracts are consistent with their callers; the audit found no schema that disagrees with its use. Three things to do:

### [ ] 8.6 Move API-only logic out of the contracts package

- **Today:** `pond-counter.ts` (207 lines), the banding functions (`chat.ts:369-416`, `matching.ts:269`, `research.ts:168`) and `cardFields` are used only by the API and the seed. Because the package is exported whole, the phone app bundles them.
- **Change:** move them into `apps/api/src/<slice>/`. No lines saved; a smaller phone bundle and a contracts package that holds only contracts.
- **Check:** `pnpm openapi` produces no diff.

### [ ] 8.7 Comments

20–43% of the big files (`profile-fields.ts` 586, `media.ts` 429, `chat.ts` 416). Covered by phase 5; listed here because this package is the worst.

### [ ] 8.8 Types nobody uses

About 20 exported types have no user. `pnpm knip` lists them once the test files that only import them are gone (phase 4).

## `packages/db`

The schema and migrations are out of scope. The seed and demo tooling is in phase 3.7.

### [ ] 8.9 The CLI guards

Bugs B1 and B2 (phase 0). After them, the three CLIs (`seed`, `migrate`, `moderator`) share one "which database is this, and is that allowed" check.

## `packages/i18n`

The runtime (about 450 lines) is fine. The scripts are in phase 3.8. Bugs B16 and B17 are in phase 0.

## `packages/notices`

Keep as it is (362 lines). It lists what a bundle really ships, which the standard licence tools do not do.

Its coverage floor is 100% on all four measures. Phase 2.7 lowers it with the others.

## Check for the phase

- `pnpm --filter @kuutti/admin test` and `typecheck`.
- `pnpm e2e:admin`: it runs the production build under the real CSP and fails on any console error.
- Each changed page looked at running, with the keyboard alone and with a screen reader.
