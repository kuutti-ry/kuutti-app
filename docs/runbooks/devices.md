# Kuutti on real phones

How the app gets onto a physical Android phone and an iPhone, for day-to-day work and for a demo (#5, #10). Two kinds of build exist (`apps/mobile/eas.json`), both talking to the staging API:

| profile | what it is | use it for |
|---|---|---|
| `preview` | the app as a tester runs it: no developer menu, starts straight into the app, fetches the latest JavaScript from the `staging` channel at launch | demos, showing the team, checking a merge on a phone |
| `development` | the dev client: a launcher that connects to Metro on your Mac (or opens a published update) | writing code against a phone |

Build links are on the project's builds page on expo.dev (`apps/mobile/README.md`, Installing the dev client). `main` builds `development` for Android automatically when native code changes; everything else is started by hand:

```sh
gh workflow run eas-build.yml -f profile=preview -f platform=android
```

Each build counts against Expo's free tier (30 a month, at most 15 iOS). Every profile uploads its source maps to Sentry during the build (`docs/runbooks/sentry-setup.md`): a build without readable stack traces fails, it does not ship.

## Android (any phone, no cable needed)

1. On the phone, open the build's page on expo.dev in the browser and download the APK.
2. Android asks whether the browser may install apps: allow it for this once. On Xiaomi (MIUI or HyperOS) the install dialog has a ten-second countdown and may ask to scan the app; both are normal.
3. Open Kuutti. A `preview` build shows the sign-in screen; the wrench on the home screen after sign-in, or the tech config screen, shows the staging API's version and commit: that is the check of #10's first box and #5's last.

With a cable instead (useful for logs): Settings, About phone, tap the MIUI or OS version seven times; Additional settings, Developer options, turn on **USB debugging** and, on Xiaomi, **Install via USB** (it wants a SIM card and a Mi account on some versions; if it refuses, use the browser route above). Then `adb devices` must list the phone as `device`, and `adb install <file>.apk` installs, `adb logcat '*:S' ReactNativeJS:V` shows the app's log.

## iPhone

Needs the paid Apple Developer membership (done 2026-09-20). Apple allows ad hoc installs only on registered devices, 100 a year.

1. **On the iPhone:** Settings, Privacy & Security, **Developer Mode**, on; the phone restarts. Without it an internal build installs but will not open.
2. **Register the phone**, on the Mac, as the Expo admin member (never the owner login):
   ```sh
   cd apps/mobile && pnpm exec eas device:create
   ```
   Choose the Apple team, then "Website": it prints a URL and a QR code. Open it on the iPhone, install the profile it offers (Settings, Profile Downloaded, Install). The device now shows under `eas device:list`.
3. **First build, interactive, once.** EAS creates and keeps the distribution certificate and the ad hoc provisioning profile; nothing lands in the repository:
   ```sh
   pnpm exec eas build --profile preview --platform ios
   ```
   Sign in with the Apple ID when asked, let EAS generate the certificate and the profile, and select the registered iPhone. About fifteen minutes. Repeat with `--profile development` when you want the dev client on the phone too.
4. **Install:** open the build page on the iPhone (the QR code at the end of the build, or the link on expo.dev) and tap Install.
5. **Let CI build iOS from now on** (credentials exist on EAS, so builds are non-interactive):
   ```sh
   gh variable set EAS_PLATFORMS --body "android ios"
   ```
   A new device later means `eas device:create` again and one more build: the profile lists devices at build time.

Push notification credentials (`eas credentials`: FCM service account, APNs key) can wait for push (#102); uploading them now saves a native rebuild then.

## The dev client against your Mac

Phone and Mac on the same network. `pnpm env:up` on the Mac; open the `development` build; it lists the Metro server on the Mac, or scan the QR code Metro prints. The tech config screen then shows the API on the Mac (`http://<mac>:3000`), and edits appear on save. With a cable, `adb reverse tcp:8081 tcp:8081 && adb reverse tcp:3000 tcp:3000` makes `localhost` work on Android without any network.

## Simulators and emulators

`pnpm env:up`, then `npx expo run:ios` or `npx expo run:android` in `apps/mobile` once per native change (agent shells need `export LANG=en_US.UTF-8` for CocoaPods). Screenshots and video without touching the window: `xcrun simctl io booted screenshot shot.png`, `xcrun simctl io booted recordVideo demo.mp4` (Ctrl+C stops), `adb exec-out screencap -p > shot.png`, `adb shell screenrecord /sdcard/demo.mp4`. Appearance, contrast, font size and language: `docs/design/README.md` has the commands.

## Verified links (App Links and Universal Links, #36)

The bank login returns to the app by deep link. Today that link is the custom scheme `kuutti://auth?code=…`, which both platforms open in the app without a dialog (iOS through the scheme, Android through the intent filter Expo derives from `scheme`). The https form `https://api.<env>.kuutti.app/auth/return?code=…` needs verified links, which are a native change (`ios.associatedDomains` and `android.intentFilters` with `autoVerify` in `app.json`): batch it with the next fingerprint move (#184). The API already serves the two files from configuration:

- `https://api.<env>.kuutti.app/.well-known/assetlinks.json` from `ANDROID_CERT_FINGERPRINTS`. The fingerprint is the release keystore's SHA-256: `eas credentials --platform android` prints it under the keystore. List the `development` and the `preview` build's fingerprints while they differ, and for the copy installed from Google Play its three app signing fingerprints (`docs/vendors/google-play.md`, step 8), comma separated.
- `https://api.<env>.kuutti.app/.well-known/apple-app-site-association` from `IOS_TEAM_ID` (`HM4J7X495K`).

Both are SSM parameters of those names under `/kuutti/<env>/` (plain String; the values are public). Until they are set the files answer 404 and nothing else changes.

Checking, once the native batch is installed:

- Android: `adb shell pm get-app-links fi.kuutti.app` shows `verified` for the API's host; `adb shell pm verify-app-links --re-verify fi.kuutti.app` asks again. Google's checker: `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://api.staging.kuutti.app&relation=delegate_permission/common.handle_all_urls`.
- iOS: Apple's CDN fetches the AASA on install; `curl -s https://app-site-association.cdn-apple.com/a/v1/api.staging.kuutti.app` shows what Apple has. Settings → Developer → Universal Links → Diagnostics names the reason when a link does not open.

## The lock's face and fingerprint (#418, ADR-045)

Maestro has no biometric command, so the lock's face and fingerprint are checked by hand, on a real iPhone and a real Android phone, once a build with `expo-local-authentication` is installed (the native batch, ADR-045 §8; the tech config screen names the native build). jest covers the rest with the module mocked. Sign in as Sanna, on a phone with no face or finger enrolled yet (remove them for the walk if needed): step 1 enrols one.

Whether a build carries the Face ID purpose can be read from the build itself (#505). In `apps/mobile`, `npx --no-install eas build:list --platform ios --status finished --limit 5 --json --non-interactive` names the builds and `artifacts.applicationArchiveUrl` is the `.ipa` of each. Then:

```bash
unzip -p kuutti.ipa 'Payload/*.app/Info.plist' | plutil -p - | grep NSFaceIDUsageDescription
```

Every build with the module has it (ADR-045 §8). A build with it missing offers the switch, shows no prompt when it is pressed, and says it was not confirmed. A build without the module does not start: `Cannot find native module 'ExpoLocalAuthentication'`.

On each phone:

1. **Turning it on.** Before a face or finger is enrolled, Settings › Lock says the phone has none Kuutti can use; enrol one in the phone's own settings and come back without leaving the screen: the switch is there (#464). Face or fingerprint on. On an iPhone with Face ID, iOS first asks whether Kuutti may use Face ID, with the purpose in the phone's language: check it once each in Finnish, Swedish and English. Then the prompt; a face or finger that passes turns the switch on, and a cancel leaves it off with the line that says so.
2. **No fallback to the phone's code, and the phone's pause.** Fail the prompt until it gives up (look away, or the wrong finger). iOS shows no Enter Password; Android's prompt offers no PIN, pattern or password. On iOS the lock screen then says the face or finger did not unlock, in the kind its button names. On Android a wrong finger does not end the prompt, so failing goes on to the pause. Go on failing until the phone pauses its face or fingerprint (Android after about five wrong fingers, for 30 seconds, and until the phone's own code after repeated pauses; iOS until the phone's own code): the lock screen says the phone has paused it and that opening the phone with its own code ends it, never that it did not unlock, and the button pressed during the pause says so again with no prompt (#464). Press Home and come back while it lasts: the button and the line are still there, though the module then reads Android 16's answer (its pause's code, 7) as none (#499). Android 16 may instead lock the whole phone at the fifth wrong try. That ends Kuutti's prompt as a cancel (no line on the lock screen; in Settings, that it was not confirmed), and the phone's own code then ends the pause too: note which the phone did. Lock the phone and open it with its own code: the button's prompt comes back. In Settings, turning Face or fingerprint on during the pause leaves it off with the pause's own line. The passcode (if set) and Sign in with the bank instead are there throughout.
3. **When it locks.** Straight away chosen: home, then back, and the lock asks for the face or finger at once. One minute chosen: back within it, no lock. Close the app and open it again: locked.
4. **The cover.** Open the app switcher (iOS) or recents (Android): the app's name on its background, never the last screen. On Android the thumbnail can be taken before the cover is drawn (ADR-045 §4): note what the phone shows.
5. **Android's face.** On a phone whose face unlock is class 2, with only a face enrolled: the switch is offered, and the prompt takes the face. Which phones those are, nothing official says (ADR-045 §5), so the comment names the phone. On a phone that declares face hardware whose face only unlocks the phone itself (the Pixel 7's, a class 1 face by second-hand reports), with a finger enrolled too, the button says face or fingerprint while the prompt takes the finger alone: the known ceiling of ADR-045 §5, after which the refusal and pause lines must claim nothing about the face. With only such a face enrolled, Settings › Lock says the phone has no face or fingerprint unlock Kuutti can use.
6. **Refused by the phone.** iPhone: Settings, Face ID & Passcode, Other Apps, Kuutti off (the same switch is on Kuutti's own page in Settings, under Apps). Settings › Lock then says the iPhone does not let Kuutti use Face ID, in place of the switch, with Open the phone's settings. That button opens the phone's settings: note whether it lands on Kuutti's page. Turn Face ID on for Kuutti and come back without leaving the screen: the line is gone and the switch is there (#505). With the lock already on with the face, the switch stays beside the line, so it can be turned off; the lock screen says the same in the button's place, and the passcode or the bank still opens the app; once Face ID is on for Kuutti again, the button is back and asks. Also Don't Allow on iOS's first question whether Kuutti may use Face ID, in step 1 (reinstalling the app brings the question back): the same line at once, never that it was not confirmed.
7. **The way out.** Sign in with the bank instead: the sign-in screen says the lock signed this phone out; after the bank, Settings › Lock reads Off.

A comment on the issue of the check names each phone, its system version, the build, and any step that failed. For a quick look before a phone is at hand, the iOS Simulator has Features › Face ID (Enrolled, Matching Face, Non-matching Face), and an Android emulator with a fingerprint enrolled in its settings takes `adb -e emu finger touch 1`; neither stands in for the check, since neither has the phone's own classes or prompts. The simulator of iOS 27 never shows iOS's question and has no Face ID row for the app, so step 6 needs a real iPhone (#505).
