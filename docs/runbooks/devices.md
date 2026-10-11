# Kuutti on real phones

How the app gets onto a physical Android phone and an iPhone, for day-to-day work and for a demo (#5, #10). Two kinds of build exist (`apps/mobile/eas.json`), both talking to the staging API:

| profile | what it is | use it for |
|---|---|---|
| `preview` | the app as a tester runs it: no developer menu, starts straight into the app, fetches the latest JavaScript from the `staging` channel at launch | demos, showing the team, checking a merge on a phone |
| `development` | the dev client: a launcher that connects to Metro on your Mac (or opens a published update) | writing code against a phone |

Build links land as comments on the pinned issue #17. `main` builds `development` for Android automatically when native code changes; everything else is started by hand:

```sh
gh workflow run eas-build.yml -f profile=preview -f platform=android
```

Each build counts against Expo's free tier (30 a month, at most 15 iOS). Until Sentry is set up, the `preview` profile skips Sentry's source-map upload (`SENTRY_DISABLE_AUTO_UPLOAD` in `eas.json`); `production` does not, on purpose: a release without readable stack traces should fail, not ship.

## Android (any phone, no cable needed)

1. On the phone, open the build page from #17 in the browser and download the APK.
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

Push notification credentials (`eas credentials`: FCM service account, APNs key) can wait for M4; uploading them now saves a native rebuild then.

## The dev client against your Mac

Phone and Mac on the same network. `pnpm env:up` on the Mac; open the `development` build; it lists the Metro server on the Mac, or scan the QR code Metro prints. The tech config screen then shows the API on the Mac (`http://<mac>:3000`), and edits appear on save. With a cable, `adb reverse tcp:8081 tcp:8081 && adb reverse tcp:3000 tcp:3000` makes `localhost` work on Android without any network.

## Simulators and emulators

`pnpm env:up`, then `npx expo run:ios` or `npx expo run:android` in `apps/mobile` once per native change (agent shells need `export LANG=en_US.UTF-8` for CocoaPods). Screenshots and video without touching the window: `xcrun simctl io booted screenshot shot.png`, `xcrun simctl io booted recordVideo demo.mp4` (Ctrl+C stops), `adb exec-out screencap -p > shot.png`, `adb shell screenrecord /sdcard/demo.mp4`. Appearance, contrast, font size and language: `docs/design/README.md` has the commands.

## Verified links (App Links and Universal Links, #36)

The bank login returns to the app by deep link. Today that link is the custom scheme `kuutti://auth?code=…`, which both platforms open in the app without a dialog (iOS through the scheme, Android through the intent filter Expo derives from `scheme`). The https form `https://api.<env>.kuutti.app/auth/return?code=…` needs verified links, which are a native change (`ios.associatedDomains` and `android.intentFilters` with `autoVerify` in `app.json`): batch it with the next fingerprint move. The API already serves the two files from configuration:

- `https://api.<env>.kuutti.app/.well-known/assetlinks.json` from `ANDROID_CERT_FINGERPRINTS`. The fingerprint is the release keystore's SHA-256: `eas credentials --platform android` prints it under the keystore. List the `development` and the `preview` build's fingerprints while they differ, comma separated.
- `https://api.<env>.kuutti.app/.well-known/apple-app-site-association` from `IOS_TEAM_ID` (`HM4J7X495K`).

Both are SSM parameters of those names under `/kuutti/<env>/` (plain String; the values are public). Until they are set the files answer 404 and nothing else changes.

Checking, once the native batch is installed:

- Android: `adb shell pm get-app-links fi.kuutti.app` shows `verified` for the API's host; `adb shell pm verify-app-links --re-verify fi.kuutti.app` asks again. Google's checker: `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://api.staging.kuutti.app&relation=delegate_permission/common.handle_all_urls`.
- iOS: Apple's CDN fetches the AASA on install; `curl -s https://app-site-association.cdn-apple.com/a/v1/api.staging.kuutti.app` shows what Apple has. Settings → Developer → Universal Links → Diagnostics names the reason when a link does not open.
