# A store review: the reviewers' way in, and what to check before each submission

Apple's and Google's reviewers have no Finnish bank ID, and Kumpa has no other way in. So the build they review is the staging build: it talks to the staging API, where the sign-in goes through the broker's test bank and every person is invented (ADR-018). That is the maintainer's choice of 2026-11-05 on #560; the record of it is still to be written (#560's first box). This runbook says what to check before a submission to either store, who looks, what the forms say, what not to do while a review runs, and what to do when a reviewer cannot get in. How each store's pages were filled is in `docs/vendors/app-store.md` and `docs/vendors/google-play.md`.

A reviewer is given two people, both at the test bank's Nordea, with a user ID and no password:

| User ID | Who | Where they land |
|---|---|---|
| `DEMOUSER4` | Sanna, a member with a history | in the app: a finished profile, people to decide about, likes waiting, conversations to open (`docs/demo/population.md`) |
| `DEMOUSER1` | Onni, a member with a history | in the app, as Sanna does (#560) |

Whichever test user of the bed a reviewer types instead, they land in the app too: every one that works is a member with a profile and, but for Helmi of the Mobiilivarmenne emulator, who has no photos yet, pictures, people to go through, likes and conversations (#560, the maintainer, 21/11/2026; `docs/vendors/telia.md` 1.4, `docs/demo/population.md`). Nobody who signs in through the bed lands in the sign-up steps, is refused as banned, or finds a deleted account; those states are shown on the mock bank alone. Until the night's reset after that change merged, `DEMOUSER1` was Onni in the sign-up steps, and both stores' texts as saved on 2026-11-18 still say so (What the forms say).

## Who looks

The maintainer, on the day of the submission, or a member of the team he names. An agent may run the reads below at his asking; the walk on a phone is a person's, and the bank's own page is typed by a person.

## Before sending

1. **Staging answers, and is `main`.**
   ```sh
   curl -s https://api.staging.kumpa.fi/health
   ```
   `status` and `db` read `ok`, `migrations` reads `current`, and `commit` is `main`'s tip.
2. **The links verify.** The return from the bank is a verified link (ADR-074), and each store's build is signed with that store's keys:
   ```sh
   curl -s https://api.staging.kumpa.fi/.well-known/apple-app-site-association
   curl -s https://api.staging.kumpa.fi/.well-known/assetlinks.json
   ```
   The first names `2NC5W5B372.fi.kumpa`, the second `fi.kumpa` with its fingerprints (`docs/runbooks/devices.md`, Verified links).
3. **The night's reset ran.** `gh run list --workflow demo-reset.yml --limit 3`: the last one green. A red one names the personas it spared.
4. **Both people get in, on the store's own build**: TestFlight's for Apple, the closed test's from Play for Google, never a development or preview build, which is signed with other keys. With the form's text in hand and nothing else: `DEMOUSER4` lands in the app as Sanna, `DEMOUSER1` in the app as Onni, each with People to see and a conversation to open. Do it after the reset and before the submission, and sign in as nobody else's reviewer account afterwards (While a review runs).
5. **An iPhone proves the app.** With the team id set, the API verifies an attestation that comes and refuses the sign-in when it fails (ADR-069). After step 4 on an iPhone:
   ```sh
   aws logs tail /kuutti/staging/api --since 1h --filter-pattern '"session issued"'
   aws logs tail /kuutti/staging/api --since 24h --filter-pattern '"attestation_refused"'
   ```
   The first shows the iPhone's line with `"attested":true`; the second shows nothing.
6. **The pages the forms name answer**: `https://kumpa.fi/legal/privacy/`, `https://kumpa.fi/help/`, `https://kumpa.fi/child-safety/`, `https://kumpa.fi/delete-account/`.
7. **Apple's record.** `asc validate --app 6836197661 --version-id <id>` ends without errors; `asc review details-for-version --version-id <id>` shows the notes, read again against What the forms say; the version is set to manual release while the build is a staging build.
8. **Google's record.** App content, Sign in details, read again in the console the same way; managed publishing is on (Publishing overview).

## What the forms say

Apple's notes carry the steps (the notes' other parts: `docs/vendors/app-store.md`, The first review). Google's Sign in details carries the two sets and the same steps in its 500 characters.

1. Open Kumpa, accept the terms and tap "Sign in with your bank". A browser page opens.
2. On the broker's page (Telia) choose Nordea.
3. Enter the user ID `DEMOUSER4` and tap OK. No password is asked.
4. If a page with the button VAHVISTA (confirm) appears, tap it.
5. You return to Kumpa as Sanna.

What a check on 2026-11-18 found, and the forms must keep true:

- **The reset's hour.** The reset is scheduled for 02:17 Helsinki time (`demo-reset.yml`, ADR-018), and GitHub started it between 08:39 and 10:00 Helsinki time on the four mornings of 15 to 18 November 2026. The notes say "once a day, in the Finnish morning (late evening Pacific time)", and that a person signed out at that moment signs in again.
- **The wrench.** A staging build shows a wrench on the home screen, which opens the technical screen: the API's state, the build's version, a test error, the designers' switch between styles (#408). The notes describe it, since nothing in a build may be hidden from a reviewer (Apple's guideline 2.5.19). The production build has none.
- **The bank's confirm page** did not appear in two recorded sign-ins, hence "if" in step 4.
- **A member stands where the last person left them.** After a sign-in as any test user, what was decided, written or changed there stays until the next reset; a deleted account is refused until then.
- **`DEMOUSER1` is no new member any more (#560).** Apple's notes still say "A second person: DEMOUSER1 at Nordea is a new member in the sign-up steps (the video shows this one)", and the video shows the sign-up. A reviewer who types it lands in the app as Onni. The line is reworded on the maintainer's yes, since it is a change to a record under review (`asc review details-update`); the video then shows what a reviewer no longer meets, which the notes say or the link leaves.
- **A video.** The maintainer keeps an unlisted video of the sign-in on each platform; Apple's notes link the iPhone's.

As saved on 2026-11-18, Google's steps still read "Tap VAHVISTA (confirm)" without the "if", and call `DEMOUSER1` a person "at the first step of sign-up", who since #560 is a member. They are reworded at the next change of that page, which is itself a change Google reviews.

## While a review runs

- **The two people are the reviewers'.** Nobody of the team signs in as `DEMOUSER4` or `DEMOUSER1`, on any build: a decision made as Sanna or as Onni is what the reviewer finds. The other test users are the team's and the testers' to explore (`DEMOUSER2`, `DEMOUSER3`, OP, Aktia, Säästöpankki, the Mobiilivarmenne emulator); what they like or write may reach a reviewer's person only as a card, a like or a match would reach anybody, and the night undoes it.
- **No reset by hand, and no demo on staging**, beyond the nightly reset the notes announce (`demo-reset.yml`'s dispatch, `demo-population`, `demo-stories`).
- **A merge to `main` reaches the reviewer.** Staging's API follows `main` (ADR-070), and the store build takes the `staging` channel's JavaScript when it starts (ADR-004). A merge that breaks the sign-in or the first screens on staging breaks the review; a native change does not reach the build, which then keeps its last JavaScript against the newer API.
- **The broker's test bank is not ours.** If it is down, so is the way in: `docs/vendors/telia.md`.

## If a reviewer cannot get in

A refusal comes to the Account Holder by mail and shows in App Store Connect (App Review) or in Play Console (Publishing overview, and the Inbox).

1. Steps 1 to 5 of Before sending, again: staging, the links, the reset, the walk on the store's build, the log.
2. The log around the reviewer's hour: `aws logs tail /kuutti/staging/api --since 6h --filter-pattern '"attestation_refused"'`, and the 4xx and 5xx of the sign-in routes (`docs/runbooks/alerts.md`).
3. Fix what is ours, on `main`. A wrong text in the notes or the steps is changed in the record.
4. Apple: reply in App Review with what changed, and submit again. A refusal under 4.3(b) is not a way-in problem: #374 has the plan. Google: change the page and send the change for review.

## After the verdict

- **Apple approves:** the version reads Pending Developer Release, and stays there. A staging build is never released; the release submission carries the production build (#193).
- **Google approves:** the changes wait under "Changes ready to publish" while managed publishing is on. Publishing them reaches the closed test's testers alone.

## History

- **2026-11-18.** The first submissions of Kumpa. Google approved the closed test the same day; nobody of the team watched its reviewers sign in. Apple's version 0.127.0 (build 4) went in that afternoon. The walk of step 4 by a stranger, on each store's build, has not been done yet (#560).
