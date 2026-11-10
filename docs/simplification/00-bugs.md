# Phase 0: bugs and risks

Small fixes. Each is its own pull request with a test that fails before the fix. None waits for another phase.

"Verified" means the audit read the lines named. "Reported" means read by one audit pass only: read the code first.

## Must fix

### [ ] B1. The seed can run against production (verified)

- **Where:** `packages/db/src/cli/seed.ts:12-20`
- **Problem:** The guard is `flag === "production" || APP_ENV === "production"`. `--env=production` (with an equals sign) passes. So does no flag at all with `DATABASE_URL` pointed at production through a tunnel. The seed then switches matching on and overwrites `matching_config` version 1.
- **Fix:** Call the existing `assertDemoTarget` from `packages/db/src/seed/command.ts` before opening the pool. It already refuses a managed database server whatever the environment is called. About 4 lines.
- **Test:** `--env=production` refuses; a managed host in `DATABASE_URL` refuses with `APP_ENV` unset.

### [ ] B2. The moderator CLI has the same weak guard and writes no audit row (reported)

- **Where:** `packages/db/src/cli/moderator.ts:54-58, 127-143`
- **Problem:** Same string guard as B1. Grant and revoke write nothing to `audit_log`. Revoke is two statements with no transaction.
- **Fix:** Same `assertDemoTarget`-style check for "is this a managed server, and did the caller say so on purpose". One audit insert. Wrap revoke in `transaction()`.
- **Test:** Grant writes one audit row; revoke that fails halfway changes nothing.

### [ ] B3. Push holds a database transaction during the network call (verified; needs D7)

- **Where:** `apps/api/src/notifications/push.ts:199-248`
- **Problem:** `sendPart` opens a transaction, takes `FOR SHARE` locks on account, session and push token, then awaits `pusher.send` inside it. The pool has 10 connections. If Expo is slow, about nine messages in flight empty the pool for up to 5 seconds, and sign-out and erasure of those accounts wait too.
- **Fix:** One plain `SELECT` of the live tokens just before the send. Send outside any transaction. The push text is generic ("you have a message"), so a millisecond race tells nobody anything. Removes about 40 lines.
- **Needs the maintainer:** the comment at `:209-211` says holding the locks is deliberate. D7.
- **Test:** A pusher that never answers must not block a second, unrelated query on a pool of size 2.

### [ ] B4. The e-mail code is sent inside a transaction (verified; needs D7)

- **Where:** `apps/api/src/identity/email.ts:124-150`
- **Problem:** `mailer.send` runs inside the transaction that holds the account row lock. One account sending 10 parallel `POST /account/email/code` while SES is slow holds all 10 connections. A failed send also rolls back the day's count, so the daily cap never bites during an outage.
- **Fix:** Record and commit, send after. On `MailFailed`, delete the send row and the code row, as `identity/export.ts:62-66` already does for a failed export. About 8 lines.
- **Test:** A mailer that hangs must not block another query; a failed send still leaves the count as it was before.

### [ ] B5. A moderator can approve a photo nobody saw (verified)

- **Where:** `apps/admin/src/features/media/PhotoQueue.tsx:85-98, 235-240`
- **Problem:** Approve is disabled only while saving. It works while the picture is loading, after its URL request failed (the picture then stays "loading" forever), and while a sensitive photo is still hidden.
- **Fix:** `disabled={state.kind === "saving" || !url || !shown}`. One line.
- **Test:** Approve is disabled until the image URL is set; disabled for a sensitive photo until "Show" is pressed.

### [ ] B6. Photos that missed their check wait days, or forever (verified)

- **Where:** `apps/api/src/media/moderation.ts:653-685`, `apps/api/src/media/repo.ts:677-695`
- **Problem:** The nightly retry takes the 50 oldest pending photos once. After an outage with 200 pending photos, the last wait four nights. Fifty photos that always fail (card file missing) are picked again every night and newer ones are never reached.
- **Fix:** Loop until the query returns nothing that was not already tried in this run. Keep a `Set` of ids tried.
- **Test:** 120 pending photos are all checked in one run; 50 that always fail do not stop the 51st.

### [ ] B7. `env:up` and `env:down` can kill another project's servers (verified for the prefix; the rest reported)

- **Where:** `scripts/dev-env.ts:177` (prefix), `:184-197` (process tree), `:311-319` and `:636-641` (Homebrew PostgreSQL)
- **Problem:** "Ours" is `cwd.startsWith(ROOT)`. A sibling checkout `kuutti-app-site` or a worktree `kuutti-app-wt` on port 3000, 8081 or 5173 counts as ours and gets SIGTERM, then SIGKILL. The script is also reported to run `pg_ctl stop` on a developer's own Homebrew PostgreSQL.
- **Fix:** `cwd === ROOT || cwd.startsWith(ROOT + sep)`. Never stop a database the script did not start: fail and name who holds the port. Phase 3 then removes the Homebrew fallback whole.
- **Test:** The script's self-test gets a case for a sibling path.

### [ ] B8. The chat screen shows "load failed" on a brand-new match (verified)

- **Where:** `apps/mobile/src/features/chat/ConversationScreen.tsx:290-293`
- **Problem:** On a failed refresh the screen goes to "failed" when `loaded.current.length === 0`. A new match has no messages, so any failed background refresh replaces the ready screen and the composer.
- **Fix:** Test `held.current.detail === null` instead. One line.
- **Test:** Empty conversation, loaded once, then a failing refresh: the composer is still there.

### [ ] B9. A failed send overwrites what was typed meanwhile (verified)

- **Where:** `apps/mobile/src/features/chat/ConversationScreen.tsx:476`
- **Problem:** The field is cleared on send and stays editable. On failure the code does `setText(body)`. Type B while A is sending, A fails, B is gone.
- **Fix:** `setText((now) => now || body)`.
- **Test:** Send A, type B, fail A: the field holds B.

### [ ] B10. A break ends before the person is signed in (verified in code; intent to confirm)

- **Where:** `apps/api/src/identity/login.ts:297-304`
- **Problem:** A paused account is resumed at the bank callback. If the app never completes the exchange (deep link not opened, the 60-second code expired, attestation refused), the person is back in other people's queues while signed out.
- **Fix:** Decide `unpaused` at the callback, but call `resumeAccount` in the exchange, after `consumeAppCode` succeeds.
- **Test:** Callback without exchange leaves the account paused.

## Should fix

### [ ] B11. The panel's sign-in hangs on a network error (reported)

- **Where:** `apps/admin/src/features/identity/session.tsx:90-92`
- **Problem:** The exchange call has no catch. If `fetch` rejects after the bank redirect, the state stays `loading` and the one-time code is already gone from the address bar.
- **Fix:** `.catch` to `signed-out` with the generic error. 3 lines.

### [ ] B12. A photo can be cached under another photo's key (reported, narrow)

- **Where:** `apps/mobile/src/features/media/PhotoImage.tsx:14-39, 83`
- **Problem:** `url` is not reset when `id` changes, and an answer is not checked against the current id. The old signed URL is drawn with the new `cacheKey` and written to disk.
- **Fix:** Keep `{key, url}` together in state, as `CachedPhoto.tsx:29` already does.

### [ ] B13. Uploads have no timeout (reported)

- **Where:** `apps/mobile/src/features/media/client.ts:146-158`
- **Problem:** `xhr.timeout` is never set, so `ontimeout` cannot fire. A stalled chat photo leaves Send disabled until the screen is left.
- **Fix:** Set `xhr.timeout`.

### [ ] B14. A contact typed in Settings can be lost silently (reported)

- **Where:** `apps/mobile/src/features/chat/YourContacts.tsx:256-279`
- **Problem:** The save on unmount swallows its failure.
- **Fix:** Reuse `formOf` and report through the existing `useReportUnsaved`.

### [ ] B15. An arbitrary error message is logged in clear at the bank callback (reported)

- **Where:** `apps/api/src/identity/login.ts:327-330`
- **Problem:** A non-kit error's `message` is copied into the logged detail. The logger blanks error messages everywhere else because they can quote values.
- **Fix:** Pass `error.name`, not `error.message`.

### [ ] B16. Finnish numbers are refused as phone numbers in translations (reported)

- **Where:** `packages/i18n/scripts/lib/translate.ts:155, 200`
- **Problem:** `1 000 000` matches the phone pattern; the English `1,000,000` does not, so the check reports a phone number that the source does not have.
- **Fix:** Strip digit-group separators before comparing. About 3 lines.

### [ ] B17. The inline-string lint misses conditionals (reported)

- **Where:** `packages/i18n/scripts/lib/ui-strings.ts:20-26`
- **Problem:** `{ok ? "Done" : "Failed"}` passes the check.
- **Fix:** Look inside ternary and `&&` branches. About 8 lines.

### [ ] B18. "Profile is complete" means two things (verified both exist; which is intended is the maintainer's)

- **Where:** `apps/api/src/jobs/pool.ts:63-152` and `apps/api/src/jobs/pond-counter.ts`
- **Problem:** The queue requires gender, birth month, intent, a home and current consents on top of `completeness()`. The public counter requires only `completeness()`. A person with an outdated consent is counted but is in nobody's queue.
- **Fix:** Decide which is right. If the queue's, the counter groups the result of `subjectsOfPond` and its own SQL goes (about 40 lines).

### [ ] B19. The photo cap is check-then-insert (reported, low)

- **Where:** `apps/api/src/media/repo.ts:104-139`
- **Problem:** Two uploads at the same moment at cap minus one both pass.
- **Fix:** The advisory lock message photos already take (`chat/photos.ts:176`), or mark it `shortcut:` with its ceiling.

## Suspected, check before acting

- **A thumbnail may show pixels the check never saw.** `apps/api/src/media/pipeline.ts`: the automatic check sees the card (a 3:4 crop); the thumb is a separate square crop of the full image. Needs a test with a real wide image. A fix touches ADR-006 §1.
- **The session "alive" rule is written three times** (`lib/auth-middleware.ts`, `identity/repo.ts:520-523`, `:457-461`). Not a bug today. Phase 6 makes it one.
