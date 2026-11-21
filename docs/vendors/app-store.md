# App Store Connect and TestFlight (Apple)

What Apple's developer program, App Store Connect and TestFlight are to Kuutti, and what Apple receives through them. Since 2026-11-02 the association has an organisation membership of the Apple Developer Program: Kuutti ry, team `2NC5W5B372`, its annual fee waived, renewed on 2027-11-03, with the maintainer's Apple Account at the association's address as its Account Holder (`docs/runbooks/custody.md`). The app is `fi.kumpa`, Kumpa, since #184's native batch (ADR-063 §7): a second App ID on the team, registered on 2026-11-17, with a record of its own, Kumpa (6836197661), since 2026-11-18. Until then it was `fi.kuutti.app`, whose App ID and record, Kuutti (6829809045), stay as they are: what this file says happened on a day in early November 2026 happened to that app, and Setting up `fi.kumpa`, below, says what is done again. The one distribution in use is TestFlight's internal testing, which carries the staging app to the team (ADR-063); the development and preview builds stay ad hoc (`docs/runbooks/devices.md`). Since 2026-11-18 version 0.127.0 of Kumpa, that same staging build, is also with App Review, held for manual release (The first review, below). No credentials in this file, and no address but the public ones.

## What Apple receives

| What | Why |
|---|---|
| Each iOS build EAS submits, with its build number | TestFlight hands it to the testers |
| The testers: the team's names and Apple Accounts, as users of the association's team in App Store Connect | who may install from TestFlight (ADR-063 §2) |
| The API key's calls: the upload, and the internal group EAS sets up | ADR-063 §3 |
| Since 2026-11-18: the listing, the screenshots, the age rating, the App Privacy answers, the review contact and the reviewers' way in | Apple's review and the store page (#188, #299, #560) |

From the testers' phones TestFlight sends Apple crash logs and usage data, which nobody can switch off. Apple shows the association each tester's name and invitation address, installs, sessions, app version, device model and identifier, system version, language and symbolicated crash logs, never the device's name. Screenshots, comments and the phone's state (carrier, time zone, battery, free space, connection) come only when a tester sends feedback, and a group can switch in-app feedback off. Apple keeps feedback for a year and crash and usage data until the bugs are resolved; App Store Connect offers crash reports for 120 days. The app adds no Apple library of its own for any of it.

## The keys

- **The distribution certificate** of the association's team, which EAS holds and hands to every cloud build: it signs the staging build for App Store Connect, and the ad hoc builds with their own profiles.
- **The provisioning profiles**: an App Store profile for the staging and production builds, and an ad hoc one listing the registered devices for the development and preview builds. EAS makes and keeps them.
- **The App Store Connect API key**: a team key, made by EAS at the first interactive run and held by EAS alone. ADR-063 §3 gives it the App Manager role; the one in use reads Admin on EAS (read on 2026-11-05, ADR-063, Open 6). A team key reaches every app of the team, and its role cannot be changed afterwards (ADR-063 §3).
- **The maintainer's own App Store Connect key**, for the `asc` command-line tool: in the maintainer's Keychain, not at EAS. It wrote Kuutti's listing on 2026-11-02 and Kumpa's record on 2026-11-18 (The first review), and reads builds and groups. Its role has not been read (ADR-063, Open 7).
- **The APNs key** of the team, for push through Expo (ADR-055, `docs/vendors/expo.md`). It is the kind that serves both environments; Expo does not say whether its push service takes Apple's newer keys held to one environment or to chosen apps (ADR-063, Open 4).

## Moving `fi.kuutti.app` from the individual team

The App ID and every iOS build until 2026-11-02 are on the maintainer's individual team `HM4J7X495K`. Apple transfers an app only after it has been released on the App Store, so the App ID is deleted there and registered again on the association's team (ADR-063 §4). The deletion is allowed because nothing was ever uploaded to App Store Connect with it. Every profile that contains it becomes invalid, so the old development and preview builds are expected to stop opening. Between the deletion and the new registration any team could register the identifier, so the two follow at once (steps 2 and 3). CI builds iOS on every native change on `main` (`EAS_PLATFORMS`), and such a build would fail between the steps: no native merge meanwhile, or `gh variable set EAS_PLATFORMS --body android` for the switch and `--body "android ios"` after it.

## Setting up `fi.kumpa`, the maintainer's

The App ID `fi.kumpa` (explicit, Kumpa) is registered on the association's team since 2026-11-17. Nothing is deleted or moved this time, so none of the timing of the section above applies, and nothing of `fi.kuutti.app` is touched. In order:

- **The capabilities.** The batch's build asks for Associated Domains and App Attest (ADR-074), and push as before. An interactive run of EAS switches on what the build's entitlements name; a build from CI cannot, so the first build is the interactive one, next. Done on 2026-11-17 by that build: "Synced capabilities: Enabled: App Attest, Associated Domains, Push Notifications".
- **The first build, interactive**, as step 3 of the next section, on a checkout of `main` that carries the batch: EAS makes the App Store profile of `fi.kumpa` and offers push, where the team's key it already holds is the one to choose, not a new one. The build needs no record in App Store Connect; its upload does, so the run goes without `--auto-submit`. Done on 2026-11-17 from `main` at `d617ae36`: build 4 (0.127.0), signed with the team's distribution certificate, the one `fi.kuutti.app` uses, with the team's push key attached.
- **The record.** App Store Connect, Apps, New App: iOS, the name Kumpa, the bundle identifier `fi.kumpa`, a SKU of its own, full access. Its Apple ID goes into the submit profile's `ascAppId` in `eas.json` (ADR-063 §7). App Store Connect was down on 2026-11-17, and the maintainer made the record on 2026-11-18: Kumpa, SKU `kumpa-ios`, primary language English (U.K.). Its Apple ID, 6836197661, is the `ascAppId`.
- **The first submission, interactive.** EAS attaches an App Store Connect key to a new app only in an interactive run, so until then CI's staging build of Kumpa is built and fails at its submission (When something goes wrong). In `apps/mobile`, from a checkout whose `eas.json` names the record, as the Expo admin member:
  ```sh
  EXPO_APPLE_ID=<the Account Holder's Apple Account> pnpm exec eas submit --platform ios --profile staging --id <the build's id on EAS>
  ```
  EAS offers the team's key, the one `fi.kuutti.app` submits with: that one, not a new key, since a team key reaches every app of the team anyway (ADR-063 §3). EAS then uploads the build into the new record and creates its internal group "Team (Expo)".
- **The ad hoc profiles**, as step 4 of the next section, for the development and preview builds: the registered phones are the team's and stay. Done on 2026-11-17 with `--profile development`, for the one registered iPhone; `preview` builds with the same profile, since EAS keeps one build credential per distribution type.
- **The testers**, as step 5 of the next section: the team's users get access to Kumpa, and the internal group of the new record gets them.
- **The team id of the verified links**, step 6 of the next section, unchanged: the team is the same.

## What the association set up for `fi.kuutti.app`, the maintainer's

1. **The agreement.** The Apple Developer Program License Agreement, accepted by the Account Holder (done 2026-11-02); no app can be added before it. A free app needs no other agreement.
2. **Free the identifier.** In App Store Connect on the individual team, check that no app exists for `fi.kuutti.app`; if one does, stop, since Apple refuses the deletion and ADR-063 is reopened. Then at developer.apple.com, on that team: Certificates, Identifiers & Profiles, Identifiers, `fi.kuutti.app`, Remove. On 2026-11-02 the maintainer removed it, and with it everything else of that team but its one registered device, so step 7 is done too.
3. **The first run, interactive, at once after step 2.** In `apps/mobile`, from a checkout of `main` with nothing uncommitted (an `app.json` that an `eas` run left at the repository's root counts), as the Expo admin member, with the Account Holder's Apple Account:
   ```sh
   EXPO_APPLE_ID=<the Account Holder's Apple Account> pnpm exec eas build --platform ios --profile staging --auto-submit
   ```
   Choose the team Kuutti ry. EAS registers `fi.kuutti.app` on it, makes the distribution certificate and the App Store profile, and offers to set up push: yes, a new key. For the submission it offers to make an App Store Connect API key: App Manager, not the default Admin. If the Account Holder has not yet requested access to the API, App Store Connect asks for that first (Users and Access, Integrations), and Apple grants it case by case. The submission goes to the app record that the submit profile's `ascAppId` names. EAS makes a missing record only in an interactive run, and on 2026-11-02 it failed to (its language code for Finnish is `fin`; a team's first app needs a company name, which Apple never changes afterwards; and it reported the name Kuutti as taken), so the maintainer made the record in App Store Connect, Apps, New App: iOS, company name Kuutti ry, name Kuutti, primary language English (U.S.), since 2026-11-02 English (U.K.) and the listing's only language (ADR-063, Open 5), the bundle identifier `fi.kuutti.app`, SKU `kuutti-ios`, full access. Its Apple ID, 6829809045, is the `ascAppId`. When the build is done, EAS uploads it, creates the internal group "Team (Expo)" with automatic distribution, and invites the team's Admins. This is one of the month's 15 iOS builds.

4. **The development and preview builds.** Register each phone again on the new team (`docs/runbooks/devices.md`, iPhone, step 2, team Kuutti ry), then make the ad hoc profile there without spending a build:
   ```sh
   EXPO_APPLE_ID=<the Account Holder's Apple Account> pnpm exec eas credentials:configure-build --platform ios --profile development
   ```
   and the same with `--profile preview`. The next native change on `main` builds on them. EAS keeps one build credential per distribution type, so step 3 moves only the App Store one, and until this step every development and preview build fails in Xcode, while EAS still calls the old profile active. Done on 2026-11-04, with one iPhone registered.
5. **The testers.** App Store Connect, Users and Access, +: each team member's Apple Account, with the Developer or Marketing role and access to Kuutti alone. An invitation lapses after three days and can be sent again. Once it is accepted: TestFlight, Internal Testing, the group "Team (Expo)", add the tester. The list is Play's (ADR-063 §2). Each tester installs TestFlight on the iPhone, accepts the e-mail invitation and installs Kuutti.
6. **The team id of the verified links.** `/kuutti/<env>/ios-team-id` becomes `2NC5W5B372` in each environment where it is set (`devices.md`, Verified links), and the API is restarted. It matters once #184's native batch is installed. On staging it is set: on 2026-11-18 its file named `2NC5W5B372.fi.kumpa`, and that day the API read an iPhone's attestation for the first time (ADR-069, #184).
7. **The old team.** Once a tester has installed from TestFlight and a push has reached that phone: on the individual team, revoke the APNs key and the distribution certificate (Certificates, Identifiers & Profiles, Keys and Certificates) (ADR-063 §5).

On 2026-11-02 build 4 went this way, and the maintainer installed it from TestFlight that evening, with his personal Apple Account invited as a Marketing user of the team; Apple took the version 0.0.0. From then on every start of the `staging` profile reaches the internal group without a click: `gh workflow run eas-build.yml --ref main -f profile=staging`, or `-f platform=ios` for iOS alone. Start it at least every 90 days: a TestFlight build stops opening 90 days after its upload.

## Before external testing (#193)

None of this is needed for internal testing. External testing (ADR-063, Open 2) needs:

- the test information: what to test, a feedback address (`hello@kumpa.fi`, the website's), the privacy policy, and the reviewers' sign-in, which bank identification cannot give them (#560). On 2026-11-21 neither Kumpa nor Kuutti had any of it (`asc testflight review view --app <id>`, `asc testflight app-localizations list --app <id>`);
- Apple's review of the first build of each version.

## The first review (#193, #188, #374, #560)

On 2026-11-18 Kumpa's record was filled, and the maintainer submitted version 0.127.0 with build 4 to App Review on the website. The build is the staging build, as #560's comment of 2026-11-05 chose for the review build: every person in it is invented, and the bank is the broker's test bank. The submission is there to meet Apple's guideline 4.3(b) (#374) and the reviewers' way in (#560) once before the release. It releases nothing: the version is set to "Manually release this version" (`MANUAL` in the API; a new version starts at `AFTER_APPROVAL`), and an approved staging build is never released. The release submission carries the production build (ADR-063 §6).

What the record holds, in English (U.K.) alone (ADR-063, Open 5):

| Field | What it holds |
|---|---|
| Version | 0.127.0, the build's own. A new record's first version reads 1.0, and a build attaches only to a version that reads what the build reads |
| Name, subtitle | Kumpa; "Free dating, bank ID verified" |
| Description | an opening line, five short points and a closing line, the text Play's listing carries too: a non-profit's app, nothing to buy and no ads, one bank-verified adult per account, people one at a time with buttons, photos checked and people reportable, the data yours to download or delete, open source, for people of 18 and over in Finland |
| Promotional text | "Every account is verified with Finnish bank ID. Run by a non-profit association: free, no ads, nothing to buy. Open source." |
| Keywords | dating, date, singles, relationship, love, meet, finland, finnish, bank id, verified, no ads, free, non-profit |
| Addresses | privacy policy `https://kumpa.fi/legal/privacy/`, support `https://kumpa.fi/help/`, marketing `https://kumpa.fi/` |
| Categories | Lifestyle, then Social Networking (Apple has no Dating category) |
| Age rating | the questionnaire answered as for Kuutti on 2026-11-02, with Apple's override at 18+ |
| Content rights | third-party content the association may show: people's own photos and texts (the terms' section 5) |
| Price and availability | free, with Finland as the base country; every country but China mainland, whose App Store asks for an ICP filing number: the bank login, not the country list, keeps Kumpa to Finland. Countries Apple adds later are off, which the website alone sets |
| Copyright | 2026 Kuutti ry |
| Screenshots | the iPhone 6.9" set, 1320 by 2868: five real screens of the staging app with a caption each, placeholders until #413. The first is the bank sign-in (#374's point 2) |
| App Privacy | published: nothing is used for tracking. Linked to the person: name, e-mail address, phone number, other contact info, sensitive info, coarse location, photos, other user content, customer support, user ID, device ID, product interaction, fitness, other data. Not linked: crash and performance data, since the app strips the person from every report it sends to Sentry |
| Digital Services Act | the association's declaration, active since 2026-11-05 (App Store Connect, Business) |
| App Review Information | a contact of the association with `hello@kumpa.fi`, the website's address (`hello@kuutti.app` when it was sent; changed on 2026-11-21); no demo account, since there are no passwords; the notes |

The notes are plain text of at most 4,000 characters; these take 2,617. Their parts: Signing in (a link to an unlisted video of it, why bank identification is the only login, guideline 4.8, that this is the staging build, the five steps and a second person, `DEMOUSER1`, whom the notes call a new member in the sign-up steps and who since #560 lands in the app as a member; the line is reworded on the maintainer's yes, `docs/runbooks/store-review.md`); What is different (4.3(b)); User-generated content (1.2); Account deletion (5.1.1(v)); Age.

How it was written:

- **Through the App Store Connect API**, with `asc` and the maintainer's key: the texts, the categories, the age rating, the price and the countries, the version's name and release type, the build, the screenshots, the review contact and the notes. `asc validate --app 6836197661 --version-id <id>` lists what a submission still lacks; on the day it ended at no errors and two warnings (a first version has no "what's new"; the keywords repeat words of the subtitle). `asc review details-for-version --version-id <id>` reads the contact and the notes back, and `asc review details-update --id <id> --notes "$(cat <file>)"` writes the notes. On 2026-11-21 `--contact-email hello@kumpa.fi` changed the contact the same way while the version waited for review, and it stayed in the queue.
- **App Privacy**, which the API does not take: `asc web privacy`, after the maintainer's own web sign-in in a terminal (`asc web auth login --apple-id <the Account Holder's Apple Account>`; the password and the code are his to type). `pull` reads the answers, `plan` compares a file with them and changes nothing, `apply` writes a draft, and `publish --confirm` publishes it.
- **On the website**, by the maintainer: the record itself, the Digital Services Act declaration and the submission.

While the version waits for review, Apple lets "certain app information" be edited in place and refuses screenshots; a change to those, or another build, means Remove from review ("Developer Rejected"), the change, and a new submission.

Left for the release submission (#193): the listing in Finnish and Swedish (#55), the real screenshots (#413), the notes written again for the production build (#560, #374), and the production build itself.

## When something goes wrong

- **Sentry answers an upload with "gateway timeout (http status: 504)" after "Uploaded files to Sentry":** Sentry's side, as on 2026-11-02, when it failed two iOS staging builds in a row, first at the source maps and then at the native debug symbols. Since then the `preview` environment allows a failed upload (`devices.md`), so the build goes on with a `warning: sentry-cli` line, and that build's stack traces are unreadable. The warning that the token's `https://sentry.io` is used rather than `https://de.sentry.io/` is not the failure: Sentry routes the one to the other.
- **"The bundle identifier … is not available":** `fi.kuutti.app` is still on the individual team (step 2), or another team registered it between steps 2 and 3. In the second case only Apple's support can help, and ADR-063 is reopened.
- **CI's staging build fails at its submission with "Set ascAppId in the submit profile":** the submit profile `staging` has lost its `ascAppId`, the Apple ID of the record Kumpa, 6836197661 (App Store Connect, the app, App Information).
- **"App Store Connect API Keys cannot be set up in --non-interactive mode":** no key is assigned to the app on EAS: step 3 did not finish, or `fi.kumpa`'s first submission has not been made (Setting up `fi.kumpa`). The build ran anyway: `eas submit --platform ios --profile staging --id <build id>` in `apps/mobile`, interactive, sets the key up and submits it.
- **An interactive run fails at the Apple sign-in or at a profile**, with "The first argument must be of type string… Received undefined", or with a 401 while making a profile and a 400 on signing in again: Apple's side, as on the evening of 2026-11-17, when Apple's developer system status (https://developer.apple.com/system-status/) showed App Store Connect down. Nothing is spent before the upload, so the run is started again later. Each attempt counted the build number up, which is why Kumpa's first finished build is 4.
- **A development or preview build fails at its profile** after the move: no device is registered on the new team, or the ad hoc profile was not made there (step 4).
- **A build waits with "Missing Compliance":** `app.json` answers the encryption question (`ITSAppUsesNonExemptEncryption`, false), so this means a build made without it.
- **A tester sees no build:** the invitation as a user is not accepted (it lapses after three days), the tester is not in the group, Apple is still processing the build, or the build is older than 90 days.
- **No push reaches an iPhone after the move:** EAS has no APNs key of the new team (`eas credentials -p ios`, Push Notifications, Add a new push key: "Set up your project to use Push Notifications" stops at "already set up" while any key is attached, the old team's too, as on 2026-11-04). The app's own team on EAS also still reads the individual team, which builds ignore; whether Expo's push service reads it is unproven (ADR-063, History).
- **A build does not attach to the version:** the version reads something else than the build (a new record's first version reads 1.0). Rename the version first.
- **A price is refused for its start date:** the date must be the current day in Pacific time, not Helsinki's.
- **A reviewer cannot sign in, or Apple refuses the version:** `docs/runbooks/store-review.md`, If a reviewer cannot get in.
- **A bad build:** App Store Connect, TestFlight, the build, Expire Build; the next staging build replaces it. A bad JavaScript update is stopped at EAS, not here (ADR-004, `docs/runbooks/incident.md`).

## Sources, read on 2026-11-02

The first review is what App Store Connect and `asc` 5.17.1 showed on 2026-11-18, not Apple's documentation, but for the statuses: https://developer.apple.com/help/app-store-connect/reference/app-information/app-and-submission-statuses (read on 2026-11-18).

- Apple, App Store Connect: https://developer.apple.com/help/app-store-connect/transfer-an-app/app-transfer-criteria (the release needed for a transfer), https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api (API access requested by the Account Holder; team keys reach every app), https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api, https://developer.apple.com/documentation/appstoreconnectapi/revoking-api-keys, https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds (who may upload), https://developer.apple.com/help/account/manage-your-team/roles/ (what each role may do), https://developer.apple.com/help/app-store-connect/manage-your-team/add-and-edit-users (invitations lapse after three days), https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app (the agreement first; the company name set once).
- Apple, TestFlight: https://developer.apple.com/testflight/, https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers, https://developer.apple.com/help/app-store-connect/test-a-beta-version/view-tester-feedback, https://www.apple.com/legal/privacy/data/en/test-flight/ (published 2025-01-27: what TestFlight collects and shares).
- Apple, certificates and push: https://developer.apple.com/help/account/identifiers/delete-an-app-id (who may delete; profiles become invalid), https://developer.apple.com/news/?id=wy4tb0uo (2025-02-17: APNs keys held to an environment or to apps), https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns, https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleshortversionstring.
- Apple's forums, its engineers on registering an identifier another team deleted: https://developer.apple.com/forums/thread/719010, https://developer.apple.com/forums/thread/706557; on creating apps through the API, which it refuses: https://developer.apple.com/forums/thread/759126, https://developer.apple.com/forums/thread/851298.
- Expo: https://docs.expo.dev/submit/ios/ (updated 2026-10-12), https://docs.expo.dev/submit/testflight/ (2026-07-21), https://docs.expo.dev/eas/json/ (2026-10-13: the submit profile's fields), https://docs.expo.dev/app-signing/app-credentials/ (2026-10-26).
- eas-cli's source at commit 821e7f8 of 2026-10-30 (https://github.com/expo/eas-cli): `submit/ios/IosSubmitCommand.ts` (`ascAppId` in a non-interactive run), `credentials/ios/actions/SetUpAscApiKey.ts` and `appstore/ascApiKey.ts` (the key and its roles), `submit/ios/AppProduce.ts` and `appstore/ensureAppExists.ts` (the record, interactive only; a suffix on a taken name), `ensureTestFlightGroup.ts` (the group "Team (Expo)").
