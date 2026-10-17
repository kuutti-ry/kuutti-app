# End-to-end flows (Maestro)

Flows that drive the app on a simulator against the local environment: the real API on Postgres, the mock bank, the S3 stand-in (#164, ADR-020). They are YAML read by [Maestro](https://maestro.mobile.dev), the same files for iOS and Android.

## Run

1. Once: `brew trust mobile-dev-inc/tap && brew install --formula mobile-dev-inc/tap/maestro` (the tap is Maestro's own; `--formula`, since the cask is the desktop app). It brings OpenJDK keg-only, which `pnpm e2e` puts on the PATH; to call `maestro` yourself, `export PATH="$(brew --prefix openjdk)/bin:$PATH"` first.
2. Once per release of pictures: `pnpm demo:assets`. The cast's photos come from it, and so do the pictures the onboarding flow picks.
3. `pnpm env:up` in one terminal: the database, the API on 3000, Metro on 8081.
4. A booted simulator with the dev client installed (`pnpm dev:mobile` has built it before).
5. `pnpm demo:reset`: the flows start from the cast's stories (below), and some can run once per reset. Once, `pnpm demo:population` as well: an area shows its numbers from ten people up, and the home flow reads them.
6. `pnpm e2e` runs every flow under `flows/`; `pnpm e2e -- --device <udid>` picks one simulator of several; `pnpm e2e -- apps/mobile/e2e/flows/language.yaml` runs one flow; `pnpm e2e -- --shard 2/4` runs the second of four stretches of the order, as a CI job does. `maestro studio`, or `maestro hierarchy` on the screen as a flow left it, shows what Maestro sees, the way to find a text that does not match.

`pnpm e2e` (`scripts/e2e.ts`) copies the cached release to `apps/mobile/e2e/media`, since `addMedia` reads files inside the flows' workspace and follows no link out of it; git ignores the copy. A simulator named with `--device` is booted if it is not, and shut down when the run ends, passed or failed: left booted between runs, one gathered 127 web content processes, some 6 GB, in an hour (11/10/2026). An Android emulator stays up, since its serial cannot start it again.

### On an Android emulator

The same flows, the same command; what differs is the device. Once: a dev client for the emulator, built from the checkout (`cd apps/mobile && CI=1 npx expo prebuild --platform android --no-install && cd android && ./gradlew assembleDebug`, with JDK 17 and `ANDROID_HOME` set; `-PreactNativeArchitectures=arm64-v8a` on a Mac keeps it to one architecture), then `adb install android/app/build/outputs/apk/debug/app-debug.apk`. Each time the emulator boots:

- `adb reverse tcp:3000 tcp:3000`, and the same for 8080, 8081 and 9000: the emulator's 127.0.0.1 is then the host's API, mock bank, Metro and S3 stand-in, so nothing in the flows names another host;
- `adb shell settings put secure stylus_handwriting_enabled 0`: on Android 14 and later Gboard answers a synthesized tap on a field with its stylus tutorial, and the text goes nowhere.

Then `pnpm e2e -- --device emulator-5554`. A dev client takes its bundle only from a Metro whose fingerprint matches its build, and the generated `android/` folder is part of the fingerprint: a dev client built in a worktree wants that worktree's Metro, started on another port, named with `METRO_PORT=8082 pnpm e2e -- --device emulator-5554`.

### In CI

`.github/workflows/e2e.yml` runs the flows on every push to `main`, on a pull request that carries the label `e2e` and changes the app, the API, the packages, the mock bank or the stack (each push while the label stays), and by hand (`gh workflow run e2e.yml --ref <branch>`) (ADR-020 §6). It runs in four jobs, each a stretch of the order with an emulator and a stack of its own, after one job that finds the dev client by its fingerprint or builds it (ADR-020 §7, #226): on `ubuntu-latest`, whose emulator has KVM, the stack from `docker compose` with `env.example`, the API from source, the dev client built for x86_64 or restored by its Android fingerprint, Metro, Maestro by its checksum, and the API 36 emulator set up as above. Each job's JUnit report, the API's and Metro's logs and Maestro's screenshots of a failure are its artifact (`e2e-android-1` to `-4`) for a week.

## The flows and their cast

Each flow has a persona to itself where it changes something that another flow reads, so no flow needs another to run before it. They run in the order of `config.yaml`'s `executionOrder`, each persona's flows together, which CI cuts into its four stretches; a new flow goes into that list by its `name:`, or `pnpm e2e` refuses to run, since Maestro would quietly cut the order short at a name it cannot find. Those marked *once* change their persona for good and need a `pnpm demo:reset` before they run again; the others leave their persona as they found it.

| flow | persona | what it holds |
|---|---|---|
| `sign-in-refusals` | Tapio, Ilona, Lauri, Venla, Eetu, Siiri | banned, cooldown and under-18 refused in their words; 18 and 99 let in |
| `sign-in-links` | Sanna | a forged return link refused without touching the session; an unknown route goes home; every refusal code's text |
| `onboarding` *once* | Onni | the ten steps in order; the label after non-binary; the consent on the seek screen; closed at the intent and resumed there (#219); the steppers; two areas; three photos; bio; research; home |
| `age-window-bounds` *once* | Siiri | 94 to 99 at 99, neither end leaves the bounds; no label for a woman; two areas |
| `identity-label-on-card` *once* | Eetu | the label chosen after non-binary shows on the card after the gender |
| `terms-asked-again` *once* | Kerttu | an older wording of the terms asked again, nothing else but research |
| `sensitive-answers-withdrawal` | Noa | the consent withdrawn asks whom one seeks again, not the ages and not research; Anyone is all three |
| `account-deletion` *once* | Aino | asked first, signed out, the next login refused for the cooldown |
| `deal-breakers-limit` | Sanna | an accepted answer before saving; two at most, the third refused |
| `deal-breakers-own-answer` | Noa | only on what she answered; Answer it opens the field |
| `deal-breaker-paused` | Sanna | her own answer taken back pauses it in words; answering lifts it |
| `card` | Sanna | photo, name with the age, the information fields, nothing soft |
| `photos-gate-and-hidden-field` | Noa | one approved photo, the other in review: the gate and the profile wait; the hidden field leaves the card |
| `photos-screen` | Sanna | states in words; full size and back; a caption on and off again (#296); removal asked (the drag and its actions are jest's, #179) |
| `profile-sections` | Sanna | the list of sections; an answer saved by going back, on the card, and off again (#227) |
| `profile-contact-details` | Sanna | a phone number in the bio refused on leaving the basics, with the reason |
| `later-fields-ask-later` | Sanna | the unanswered fields in order; Ask me later writes nothing |
| `later-multi-choice-cap` | Sanna | field and work take as many as apply (#178, #239); the search box |
| `later-answer-on-card` | Sanna | two parties and the corgi on the card, and off again (#213) |
| `politics-none-alone` | Sanna | ten parties and none of them, which stands alone; no note, no search, no switch |
| `kids-labels` | Kerttu, Sanna | the future-kids answers follow having kids (#148) |
| `home-and-tech` | Sanna | the area and its numbers, the gate in words; the tech screen's API |
| `email` | Sanna | malformed refused, valid saved, removed |
| `research-switch` | Sanna | the opt-in recorded and withdrawn |
| `data-export` | Sanna | Download my data hands the zip over: the share sheet on iOS, the folder picker on Android (#237) |
| `photo-descriptions` | Sanna | the Photo descriptions row and its screen (#296): Show under photos on, Face off, both kept when the screen is opened again, then back as found; the description itself needs Rekognition, which the local stack has none of |
| `settings-survive-relaunch` | Sanna | theme, language and session outlast closing the app |
| `log-out-everywhere` | Sanna | signed out at once, not back on reopening |
| `take-a-break` | Helmi | paused behind the tick, signed out with the reason, not back on reopening; the next bank login brings her back where she left off, the photos step (#170) |
| `language` | Sanna | the language choice changes the app at once (#220) |
| `give-feedback` | Sanna | a kind ticked in words, a few lines, Send, the thanks (#171) |
| `chat-text` | Antti, Ville | Antti's list: Ville's conversation open, the silent match with Sanna in the archived group; a message Antti writes reaches Ville with its time, and Antti then sees Read under it (#348); the live socket connects, with no connection line while Antti writes (#349). Each run adds a message of its own words, so it runs again without a reset |

Mikael is left out: given the moderator role on a machine, he is spared by `pnpm demo:reset`, which then exits with an error after doing the rest.

## How a flow is written

- `common/` holds the steps flows share; `flows/` holds one file per behaviour, named for it. `flows/` is what `pnpm e2e` runs.
- A flow starts with `runFlow: ../common/sign-in.yaml`, which opens the app (`open-app.yaml`), signs out if needed (`sign-out.yaml`) and signs in at the mock bank (`bank-login.yaml`) as `PERSONA`: the persona's given and family name as the mock bank's page shows them, `Sanna Korhonen` unless the flow passes another. A flow that expects a refusal calls `open-app`, `sign-out` and `bank-login` itself, since sign-in waits for a signed-in screen. A subflow takes its persona from the caller: a default in its `env:` header would override what the caller passes, so the default is written as `${PERSONA || "Sanna Korhonen"}`.
- Texts are matched as Maestro's regular expressions, in full, and the app speaks three languages, so a tap or an assertion names the text in all three (`"Settings|Asetukset|Inställningar"`), taken from `packages/i18n/messages.yaml`; `?`, `.` and parentheses are escaped. A decorative image (a glyph, the mark) is hidden from Maestro as from a screen reader: assert the text beside it.
- The dev client draws a floating Tools button at the top right of the screen on Android, and a tap on a switch that one swipe left there opens the dev menu instead: a row whose words toggle its switch (the consents, high contrast, the break's tick) is tapped by its words. The settings list is longer than a phone screen: a row below the fold ("This device", "Your account") is reached with `scrollUntilVisible` and `centerElement: true` before the tap, and a row that says its state (the theme, the language, a consent) is matched by its title with the state after it, `"(Theme|Teema|Tema)(, .*)?"`, as the profile's rows are (#287). A row's summary is its hint, which Maestro does not read: what is chosen is asserted on the row's screen.
- A switch, to Maestro, says its state differently on the two platforms: on iOS its text is its value (`"0"` off, `"1"` on), on Android its label carries the state ("Deal-breaker: Kids, off"). A switch with words of its own is its label with an optional state, `"(Deal-breaker: Kids|…)(, .*)?"`; one whose label repeats the text beside it is `text: "0|(<the words>), off"` (or `"1|(…), on"`) with `rightOf:` those words.
- A field with a visible label of the same name is tapped by its contents, or by `below:` its label when empty. `eraseText` deletes backwards from where the tap left the cursor.
- An element half under the screen's edge counts as visible, and a tap at its centre misses: every `scrollUntilVisible` sets `centerElement: true`, and a timeout of 60 s, since an emulator reads a long screen slowly. A swipe that starts on a search box focuses it, and the keyboard then takes every swipe after it: past one (the languages, the lines of work), swipe in the left margin (`swipe: start: "3%, 75%"`). On iOS, where the keyboard stays up after typing (below), a `scrollUntilVisible` runs above it. A tap during a screen's opening animation is lost: after a deep link to a screen with chips, `waitForAnimationToEnd` before the first tap. `assertNotVisible` hardly waits; for something that is going, `extendedWaitUntil: notVisible:`.
- The keyboard: no flow uses `hideKeyboard`. On iOS it taps what lies below the field, and on a simulator `pnpm e2e` boots, the keyboard's input bar stays in the hierarchy below the screen once the keyboard is down, so Maestro counts it as up and fails the step; on Android it presses back, which left the keyboard up in CI and, with none up, leaves the screen. A tap on a text that is no button (the step's question, the field's label) closes it on both, since the screens' scroll views let such a tap through (`keyboardShouldPersistTaps="handled"`). Android's keyboard takes half the screen, so a flow that scrolls on closes it there first.
- The system browser greets its first page with screens of its own (Safari's sheets, Chrome's welcome and its notifications question); `bank-login.yaml` answers each the most private way. Chrome hands the link back without iOS's "Open in Kuutti?". The page names every persona in a short button above the cards, all in view without scrolling, and the flow taps that one: scrolled to a card, a flow could stop with the card's edge at the screen's edge, a sliver Maestro counts as wholly visible, and its tap there missed (#226).
- A condition (`when:`, a `repeat`'s `while:`) that holds is answered at once, and one that does not costs Maestro 7 s, less the time since the last tap; so does an `optional` tap on what is not there. A screen that seldom comes, such as the browser's first-use screens, is not asked for with `visible:` on every run: `platform:` is checked first and costs nothing, and a `notVisible:` that holds takes half a second, so the rare case is asked as `notVisible:` and its commands run behind a flag the condition clears (`common/bank-login.yaml`, `common/sign-in.yaml`; #226).
- The system photo picker: iOS's grid has no names to tap by, Android's names each cell by when the photo was taken; `common/pick-photo.yaml` takes the cell's place in the top row (`INDEX`) and taps it by position on iOS, by name on Android. `addMedia` puts the flow's pictures first.
- Screens are reached by deep link (`openLink: kuutti://settings`, `kuutti://profile/later/politics`), the way the handoff's manual checks did; `kuutti://` is the root, the sign-in screen when signed out. A link is answered as soon as it is sent, before the screen has changed, so the step after it waits for the link's screen (`extendedWaitUntil`), two links in a row included: Settings opened straight over a consent's screen, whose header is the row's title, and the scroll for the row found the header (14/10/2026).
- A flow leaves the app as it found it where it can (the language flow ends on the phone's language), so the next one starts clean.

## Not here yet

The admin panel (Playwright), so the moderator's decision on Noa's photos and the gate opening; iOS in CI (macOS runners have no Docker); a dev-only sign-in link should the system browser prove flaky under Maestro; the 15-minute token refresh and the two-device logout; Larger Text and dark mode as a whole-app pass, which only a screenshot judges. ADR-020 lists them.
