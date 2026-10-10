# End-to-end flows (Maestro)

Flows that drive the app on a simulator against the local environment: the real API on Postgres, the mock bank, the S3 stand-in (#164, ADR-020). They are YAML read by [Maestro](https://maestro.mobile.dev), the same files for iOS and Android.

## Run

1. Once: `brew trust mobile-dev-inc/tap && brew install --formula mobile-dev-inc/tap/maestro` (the tap is Maestro's own; `--formula`, since the cask is the desktop app). It brings OpenJDK keg-only, which `pnpm e2e` puts on the PATH; to call `maestro` yourself, `export PATH="$(brew --prefix openjdk)/bin:$PATH"` first.
2. Once per release of pictures: `pnpm demo:assets`. The cast's photos come from it, and so do the pictures the onboarding flow picks.
3. `pnpm env:up` in one terminal: the database, the API on 3000, Metro on 8081.
4. A booted simulator with the dev client installed (`pnpm dev:mobile` has built it before).
5. `pnpm demo:reset`: the flows start from the cast's stories (below), and some can run once per reset.
6. `pnpm e2e` runs every flow under `flows/`; `pnpm e2e -- --device <udid>` picks one simulator of two booted; `pnpm e2e -- apps/mobile/e2e/flows/language.yaml` runs one flow. `maestro studio`, or `maestro hierarchy` on the screen as a flow left it, shows what Maestro sees, the way to find a text that does not match.

`pnpm e2e` (`scripts/e2e.ts`) copies the cached release to `apps/mobile/e2e/media`, since `addMedia` reads files inside the flows' workspace and follows no link out of it; git ignores the copy.

## The flows and their cast

Each flow has a persona to itself where it changes something that another flow reads, so the order does not matter. Those marked *once* change their persona for good and need a `pnpm demo:reset` before they run again; the others leave their persona as they found it.

| flow | persona | what it holds |
|---|---|---|
| `sign-in-refusals` | Tapio, Ilona, Lauri, Venla, Eetu, Siiri | banned, cooldown and under-18 refused in their words; 18 and 99 let in |
| `sign-in-links` | Sanna | a forged return link refused without touching the session; an unknown route goes home; every refusal code's text |
| `onboarding` *once* | Onni | the ten steps in order; the label after non-binary; the consent on the seek screen; closed at the intent and resumed there (#219); the steppers; two areas; three photos; bio; research; home |
| `age-window-bounds` *once* | Siiri | 94 to 99 at 99, neither end leaves the bounds; no label for a woman; two areas |
| `identity-label-on-card` *once* | Eetu | the label chosen after non-binary shows on the card after the gender |
| `terms-asked-again` *once* | Kerttu | an older wording of the terms asked again, nothing else but research |
| `sensitive-answers-withdrawal` | Noa | the consent withdrawn asks whom one seeks again, not the ages; Anyone is all three |
| `account-deletion` *once* | Aino | asked first, signed out, the next login refused for the cooldown |
| `deal-breakers-limit` | Sanna | an accepted answer before saving; two at most, the third refused |
| `deal-breakers-own-answer` | Noa | only on what she answered; Answer it opens the field |
| `deal-breaker-paused` | Sanna | her own answer taken back pauses it in words; answering lifts it |
| `card` | Sanna | photo, name, verified age, the information fields, nothing soft |
| `photos-gate-and-hidden-field` | Noa | two approved photos: the gate and the profile wait; the hidden field leaves the card |
| `photos-screen` | Sanna | states and moves in words; full size and back; removal asked |
| `profile-contact-details` | Sanna | a phone number in the bio refused with the reason |
| `later-fields-ask-later` | Sanna | the unanswered fields in order; Ask me later writes nothing |
| `later-multi-choice-cap` | Sanna | three each for field and work (#178); the search box |
| `later-answer-on-card` | Sanna | two parties and the corgi on the card, and off again (#213) |
| `politics-consent-note` | Sanna | the note names the consent and Settings; no switch; twelve options |
| `kids-labels` | Kerttu, Sanna | the future-kids answers follow having kids (#148) |
| `home-and-tech` | Sanna | the area and its numbers, the gate in words; the tech screen's API |
| `email` | Sanna | malformed refused, valid saved, removed |
| `research-switch` | Sanna | the opt-in recorded and withdrawn |
| `data-export` | Sanna | Download my data hands the file to the share sheet |
| `settings-survive-relaunch` | Sanna | theme, language and session outlast closing the app |
| `log-out-everywhere` | Sanna | signed out at once, not back on reopening |
| `language` | Sanna | the language choice changes the app at once (#220) |

Mikael is left out: given the moderator role on a machine, he is spared by `pnpm demo:reset`, which then exits with an error after doing the rest.

## How a flow is written

- `common/` holds the steps flows share; `flows/` holds one file per behaviour, named for it. `flows/` is what `pnpm e2e` runs.
- A flow starts with `runFlow: ../common/sign-in.yaml`, which opens the app (`open-app.yaml`), signs out if needed (`sign-out.yaml`) and signs in at the mock bank (`bank-login.yaml`) as `PERSONA`: the persona's given and family name as the mock bank's page shows them, `Sanna Korhonen` unless the flow passes another. A flow that expects a refusal calls `open-app`, `sign-out` and `bank-login` itself, since sign-in waits for a signed-in screen. A subflow takes its persona from the caller: a default in its `env:` header would override what the caller passes, so the default is written as `${PERSONA || "Sanna Korhonen"}`.
- Texts are matched as Maestro's regular expressions, in full, and the app speaks three languages, so a tap or an assertion names the text in all three (`"Settings|Asetukset|Inställningar"`), taken from `packages/i18n/messages.yaml`; `?`, `.` and parentheses are escaped. A decorative image (a glyph, the mark) is hidden from Maestro as from a screen reader: assert the text beside it.
- A switch's text, to Maestro, is its value: `"0"` off, `"1"` on. Its words are its accessibility label, which Maestro matches when nothing else on screen says them ("Deal-breaker: Kids"); where the text beside it says the same, the switch is `text: "0"` with `rightOf:` those words.
- A field with a visible label of the same name is tapped by its contents, or by `below:` its label when empty. `eraseText` deletes backwards from where the tap left the cursor.
- An element half under the screen's edge counts as visible, and a tap at its centre misses: every `scrollUntilVisible` sets `centerElement: true`. A tap during a screen's opening animation is lost: after a deep link to a screen with chips, `waitForAnimationToEnd` before the first tap. `assertNotVisible` hardly waits; for something that is going, `extendedWaitUntil: notVisible:`. `hideKeyboard` taps what lies below the field; where a button is above the keyboard, leave it up.
- The system photo picker has no names to tap by: `common/pick-photo.yaml` taps a cell by position, and `addMedia` puts the flow's pictures first.
- Screens are reached by deep link (`openLink: kuutti://settings`, `kuutti://profile/later/politics`), the way the handoff's manual checks did; `kuutti://` is the root, the sign-in screen when signed out.
- A flow leaves the app as it found it where it can (the language flow ends on the phone's language), so the next one starts clean.

## Not here yet

The admin panel (Playwright), so the moderator's decision on Noa's photos and the gate opening; Android in CI; a dev-only sign-in link should the system browser prove flaky under Maestro; the 15-minute token refresh and the two-device logout; Larger Text and dark mode as a whole-app pass, which only a screenshot judges. ADR-020 lists them.
