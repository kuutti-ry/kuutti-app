# ADR-022: Taking a break

- Status: accepted
- Date: 2026-10-13
- Follows: TD-7 (erasure and re-registration), ADR-007 (erasure), ADR-010 §6 (activation), ADR-013 §2 and ADR-015 §3 (who counts), issue #170; #83 shares the state

## Context

The only way to disappear for a while was "Delete everything", which costs the profile, the photos and thirty days of waiting. People leave dating apps and come back; a pause that costs nothing is the design sheet's retention line. The other apps split two ways. Hinge, Tinder and Bumble hide the profile and let the person go on chatting, and Bumble's Snooze lets a match without a conversation expire meanwhile. Feeld, Instagram and S-mobiili's "Stop using" are a full stop: everything hidden, the person out, the next login the way back. Kuutti has no chat yet, and the maintainer chose the full stop with S-mobiili's screen (10/10/2026): three lines, a tick, a button that waits for it, every device signed out.

## Decision

1. **One state, with the old one kept aside.** `account.state` goes to `paused`; `paused_from` (migration 0038, nullable) keeps the state it had, `active` or `shadow_banned`, and the next bank login puts it back (`resumeAccount`). A shadow ban survives the break and shows to nobody, as ADR-013 §2 asks; without the column the resume would have to guess, and a refusal to pause would reveal the ban. `registered` cannot pause (409 `not_active`): nothing is visible yet, and a resume to `active` would skip the activation rule of ADR-010 §6. #83's "Löysin hänet" is the same state with an exit reason, a second entry point, not a second state.
2. **`POST /account/pause`, with a body.** `{ confirm: true }` like the deletion. In one transaction under the row's lock (ADR-015 §8): the state kept aside, every session revoked with the reason `paused`, one research event. 404 for an erased account, 409 `already_paused` for a second device that got through the session guard first. Nothing is deleted: the profile, the photos, the preferences, the consents, the e-mail and the gate row stay; the pool, the counter and the card leave `paused` out already (ADR-013 §2, ADR-015 §3, `profile/card.ts`). The erasure table is unchanged and `eraseAccount` stays the only delete.
3. **The next bank login ends the break.** `decideRegistration` already resumes a live account; `login.ts` sees `paused`, restores the state and answers the exchange with `outcome: "unpaused"`, so the app can say "Welcome back" once. No cadence and no waiting time: a break may end a minute after it began. A second device's login that resumed first leaves the other a plain `resumed`.
4. **Clocks keep ticking** (the maintainer, 13/10/2026). A break stops nothing that runs on its own: a match's archive after seven days without a message (#100), a pending like's fourteen days (#97), the ninety days of a research event, the photo check's twelve months. Somebody who comes back after a month finds what survived, as after Bumble's Snooze and unlike a freezer. A like given stays given (Hinge does the same); what the counterpart of a chat sees, "on a break" or nothing, is #101's decision. The screen says the three things that happen now; the clocks are said where the clocks are built, in the same change that builds them.
5. **Sessions of a paused account.** The guard's live states keep `paused`, because #83's pause keeps chats; the break's "no live session" is the revocation's doing. A login exchange that commits in the window between the guard and the pause can leave one session on a paused account, and the person uses the app paused until its next start; the exchange taking the account row's lock closes it, and that joins the day a paused session matters, with the round builder (a `shortcut:` in `pause.ts`).
6. **The app.** Settings grouped the S-Pankki way (#170): "App settings" (theme, contrast, language, the two consents, the source offer) and "Account" (this device, the e-mail, the export, "Take a break", "Delete everything"). The break is a screen of its own (`/account/break`): three lines, the switch "I understand what a break means", the button enabled after it, "Starting your break…", a failure that keeps the session. The provider signs the device out with a notice; the sign-in screen says "Your account is on a break" and the way back; the home screen says "Welcome back" after an `unpaused` login.
7. **Research.** `account_paused {}` and `account_resumed { afterDays }`, by pseudonym like every event and with no reason text (rule 5): how many step away rather than delete, and for how long.

## Consequences

- Migration 0038, one nullable column. The export never shows `paused_from`: it is non-null only while no session exists that could ask for an export.
- `AuthExchangeResponse.outcome` gains `unpaused`. An app older than this parses the exchange strictly and would refuse the value, which only a paused account receives, and no installed build can pause before it has the screen.
- The Maestro flow `take-a-break` has a persona of its own, Helmi (ADR-014 §4 as amended): the pause changes its persona's state, and a shared persona left paused by a run that failed between the pause and the resume would fail every flow after it. The Settings flows that reach the session block scroll to it now that the account group comes after the app's settings.
- Open, the maintainer's: whether the optional e-mail (#148) hears about a break (TD-18 says no mail without a reason), and the counterpart's view of a paused chat (#101).

## Alternatives considered

- **Hiding only** (Hinge, Tinder): the person keeps using the app while hidden. There is nothing to use while hidden yet, and the maintainer chose S-mobiili's model; #83 gets the hidden-but-present shape when chats exist.
- **A timed pause that ends on its own** (Bumble's 24 hours, 72 hours, a week): out of scope by the issue; the bank login is the one way back and costs nothing.
- **Resuming to `active` always, no column**: loses a shadow ban, or reveals it by refusing the pause. Rejected.
- **A state per entry point** (`paused`, `found_someone`): one state, two reasons; the reason is #83's column when it lands.
