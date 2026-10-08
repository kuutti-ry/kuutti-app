# @kuutti/mobile

Expo SDK 57, dev client, Expo Router, web target for previews. `app/` holds routes only; features live under `src/features/<slice>/`, horizontal code under `src/lib/`. Rules: `.claude/rules/mobile.md`, `.claude/rules/layout.md`.

- `pnpm start` opens the dev client (`expo start --dev-client`). Expo Go is not supported.
- `pnpm web` runs the web target against the local API.
- `pnpm test` runs jest-expo. `pnpm typecheck` runs tsc.

## Builds and updates (EAS, #10)

Native binaries come from EAS Build; JavaScript reaches installed binaries as EAS Updates. The split is the fingerprint rule: `runtimeVersion` follows the `fingerprint` policy, so a change to native code, a native dependency, `app.json` or a config plugin changes the fingerprint and needs a new build, while everything else is an update. `eas-build.yml` compares the fingerprint of `main` with the newest `development` build that finished or is still running and builds only when it differs; before it starts a build it cancels a queued or running build of the same profile and platform, since that one belongs to older code; `deploy.yml` publishes an update for every deploy. Pull requests never build: the free tier is 15 builds per platform a month (TD-2); they get an update on branch `pr-<n>` instead (#9).

| profile | what | channel | who |
|---|---|---|---|
| `development` | dev client, internal distribution: Android APK, iOS ad hoc for registered devices | `staging` | the team, for day-to-day work against Metro or the staging API; it does not apply updates by itself, you pick a branch in the launcher |
| `preview` | the app as testers run it, internal distribution; checks for an update on every launch and applies it | `staging` | staging testers, and a phone that should follow `main` without anyone doing anything |
| `production` | store build (AAB, IPA), build number incremented on EAS | `production` | releases on `v*` tags; submission is M5 |

Channels follow the deploy promotion (#8): a merge to `main` deploys the staging API and publishes to `staging`; a `v*` tag deploys prod behind the reviewer and publishes to `production`. Updates are not code-signed for now: Expo sells update signing with its paid plans only, so what may publish is whatever holds `EXPO_TOKEN`, and that token is guarded accordingly (ADR-004, which also says when signing returns). Turning signing on later adds a certificate to `app.json`, hence a new fingerprint and new builds for everyone.

Phones, step by step (Android without a cable, the iPhone's registration and first build, the dev client against a Mac): `docs/runbooks/devices.md`.

### Installing the dev client

Builds are listed on the project's builds page, https://expo.dev/accounts/kuutti/projects/kuutti/builds (an Expo account that is a member of the `kuutti` organisation is needed). If the repository variable `EAS_BUILDS_ISSUE` names an issue, the links are mirrored there too as sticky comments, one per profile.

- **Android.** Open the build's page on the phone and install the APK. Allow installs from the browser when Android asks.
- **iOS.** Ad hoc distribution installs only on registered devices. Ask the maintainer for the registration link (`eas device:create` prints a URL and a QR code), open it on the phone, install the profile; the next `development` build includes the device (Apple allows 100 per year). Then open the build page on the phone and install.

In the dev client, connect to Metro on your machine for local work (the API URL is derived from the Metro host); `pnpm env:up` and `pnpm dev:mobile` start it. A dev client built while updates were still signed (fingerprint `d9ecc75a` or earlier) refuses Metro's unsigned manifest: install the current Android build from the builds page, or rebuild locally (`expo run:ios`, `expo run:android`). Or open a published update: the launcher's *Extensions* tab lists EAS Update branches (`staging`, `pr-<n>`), and a pull-request comment's QR code opens that branch directly. The tech config screen (the wrench on the home screen, outside production) shows which API the JavaScript was built for.

### Apple account

M1 uses the maintainer's individual Apple developer account for ad hoc distribution; Apple organisation enrolment waits for the association's Y-tunnus (TD-4). Apple does not convert an individual account into an organisation, so the app record moves by transfer later; the bundle identifier `fi.kuutti.app`, the EAS project and the certificates are unaffected. Nobody but the maintainer needs an Apple login: EAS holds the distribution certificate and the provisioning profiles.

### Setting up EAS, once (maintainer)

1. **Account.** An Expo organisation `kuutti` owned by the project mailbox (TD-4); the maintainer's personal login is a member. In `apps/mobile`: `eas init --account kuutti` writes `extra.eas.projectId` into `app.json` (and `owner`); `eas update:configure` writes `updates.url`. Commit both. Until they are committed, `deploy.yml` and `eas-build.yml` do nothing (`EAS_ENABLED` unset) and the `#9` native lane reports itself dormant.
2. **Tokens.** On expo.dev, a robot user in the organisation with the Developer role; its access token is `EXPO_TOKEN` in the `staging`, `prod` and `preview` environments (never at repository level): `gh secret set EXPO_TOKEN --env staging`, and the same for the other two. #9 uses the `preview` copy for pull requests. Updates are not code-signed (ADR-004), so this token is the authority to publish to any branch and to re-point a channel (`eas channel:edit`); Expo has no narrower role for a robot. That is why it lives only in environments, why `prod` keeps its required reviewer and `preview` had one from 2026-09-25, when the `contributors` team got write, to 2026-10-08 (ADR-004 §3: write access is the trust), why the #9 native lane bundles in a step without it, why channel edits stay a maintainer action, and why both human Expo logins need 2FA. ADR-004 names who can publish to `production` today.
3. **API URLs.** The bundles built on EAS need the API URL per environment: `eas env:set --environment preview --name EXPO_PUBLIC_API_URL --value https://api.staging.kuutti.app --visibility plaintext` and `--environment production` with the production URL. CI-published updates get the same value from the GitHub environment variable `API_URL`; keep the two equal, because when `eas update` runs with `--environment` the EAS value wins over the runner's. Pull-request previews pass no `--environment` and get the pull request's own API URL from the runner. A release bundle with no `EXPO_PUBLIC_API_URL` at all throws at start (`src/lib/api.ts`) rather than talking to localhost. `EXPO_PUBLIC_*` is public by definition; nothing secret goes there.
4. **Credentials.** The first build of each platform is interactive: `eas build --profile development --platform android` lets EAS generate and keep the keystore; `--platform ios` signs in with the Apple account, creates the distribution certificate and the ad hoc profile. Then `eas credentials` to upload the push credentials (FCM service account for Android, APNs key for iOS) so M4 needs no native rebuild. After that CI builds non-interactively with `--freeze-credentials` semantics: credentials exist on EAS and never in the repository.
5. `gh variable set EAS_ENABLED --body true`. Optional: an issue that mirrors the build links for people without an Expo login, `gh variable set EAS_BUILDS_ISSUE --body <number>` (M1 used #17 and retired it once the team had Expo accounts).

Checks: an Android team member installs the dev client from the link and sees the staging API version; an iOS tester registered by UDID installs from the build page; a JS-only merge to `main` shows up in the dev client's `staging` branch without a new build; a native change on `main` starts a new `development` build (a `preview` build is dispatched by hand: `gh workflow run eas-build.yml --ref main -f profile=preview -f platform=all`) and the recorded fingerprint changes; a phone on a build with the old fingerprint stops receiving updates until the new build is installed, and the App card names the runtime for that; `gh secret list --env <env>` shows `EXPO_TOKEN` only in `staging`, `prod` and `preview`; the project on expo.dev is owned by the organisation.

## Signing in and recovering an account

Bank ID is the account: there is no password and no e-mail to recover through. The app opens the API's `/auth/start` in the system browser, the bank identifies the person, and the app receives a one-time code by deep link, which it exchanges for this device's session (an access token that renews itself, and a refresh token good for ninety days, both in the secure store). A lost or stolen phone is handled by signing in on a new phone and choosing "log out everywhere" on the settings screen: every device's session ends on its next request, and the old phone is back at the sign-in screen. Nothing is stored that could sign someone in without their bank.

## Error reporting (Sentry, #11)

Errors only, no analytics (rules/mobile.md): `src/lib/sentry.ts` builds the options and its test asserts `sendDefaultPii: false`, no tracing, no replay, no screenshots. The SDK is on exactly when `EXPO_PUBLIC_SENTRY_DSN` is set, as an EAS environment variable (plain text, DSNs are public) per environment; local runs have none. The environment name comes from the update channel (`staging`, `production`, `pr-<n>` becomes `preview`).

Source maps: the `@sentry/react-native/expo` plugin in `app.json` names the EU server, organisation `kuutti-fi` and project `mobile`, and uploads maps during EAS Build when `SENTRY_AUTH_TOKEN` is an EAS secret; for updates, `deploy.yml` runs `sentry-expo-upload-sourcemaps dist` with the token from the GitHub environment and names the organisation in `SENTRY_ORG` (the uploader reads the environment before `app.json`). The token is never in the repository or at repository level.

Which JavaScript a phone runs: `app.config.ts` stamps the git commit into `extra.commit` at export and build time (`GITHUB_SHA` in CI, `EAS_BUILD_GIT_COMMIT_HASH` on EAS, git locally), and the tech config screen shows it in its App card next to the update id, apart from the API's commit. `fingerprint.config.js` skips the `extra` section, so a new commit is never a new runtime version.
