# Google Play (Google)

What Google Play is to Kuutti, and what Google receives through it. Since 2026-10-27 the association has an organisation developer account on Google Play, with the developer name Kuutti ry, owned by the maintainer's login at the association's Google Workspace (`docs/runbooks/custody.md`). The app is `fi.kuutti.app`. The one track in use is internal testing, which carries the staging app to the team (ADR-057). No credentials in this file, and no address but the public ones.

## What Play shows of the association

Play Console's Play developer profile lists as public account details the organisation's name Kuutti ry, its registered address (public on `kuutti.app` too), the developer phone number of the account and the developer e-mail `hello@kuutti.app`. They come from the account details Google verified, and change there. Once the app is listed, its page and the developer page show them, with the website `https://kuutti.app/`.

The developer page's own content is set under Developer account, Play developer profile. As the console asked on 2026-10-27:
- the developer icon, 512 by 512, and the header image, 4096 by 2304, each a JPEG or an opaque 24-bit PNG of at most 1 MB. Google's help asks for a 32-bit PNG icon, but the console refuses transparency;
- a promotional text of at most 140 characters, translations optional: "A free dating app for Finland by Kuutti ry, a non-profit association. No ads, nothing to buy, one real person behind every account.";
- the website, and a featured app, which must be published. Google's help says the profile needs at least one published app.

The icon is the app's own and the header the site's dawn and water colours around the app's splash image, both placeholders until the designer draws them.

## What Google receives

| What | Why |
|---|---|
| Each app bundle EAS submits, with its version code | Play makes the phones' APKs from it and signs them with the keys it holds |
| The internal testers' list: the addresses of the team's Google accounts, kept by hand in the console | who may opt in and install the internal test |
| The service account's calls: which bundle goes to which track, with which status | the upload (ADR-057 §3) |
| Later, before a closed or public release: the store listing, the content rating, the target audience (18 and over only), the data safety form, the child safety declaration and the reviewers' way in | Play's review and the store page (#188, #299) |

From the phones, Play itself records installs and updates and, on phones whose owners share usage and diagnostics with Google, crashes and freezes (Android vitals). The app adds no Google library of its own: `expo-application`, which Expo's own modules pull in, carries Google's install-referrer client, and nothing in the app calls it. Nor does Play add one, while its automatic protection is off (ADR-057 §9). Google's pre-launch robots also run each uploaded bundle on test phones; in the staging app they stop at the bank login, which they cannot pass.

## The keys

- **The app signing keys**, generated and held by Google (Play App Signing). For a new app in 2026 that is a hybrid set: an RSA key for Android 16 and lower, a classical key and an ML-DSA key for Android 17 and later. Every install from Play carries them, and nobody at Kuutti holds a copy. Their SHA-256 fingerprints are in Play Console under Protected with Play, Play Store protection, Manage Play app signing (older guides say Setup, App integrity); verified links (#184) need all three. Until a release reaches open testing or production, the maintainer may still change them to the association's own key (ADR-057, Open 1).
- **The upload key**: EAS's keystore of `fi.kuutti.app`, which also signs the development and preview APKs. Play takes a bundle for a track only with its signature. EAS hands it to every cloud build, so to any holder of `EXPO_TOKEN` too. Google resets it on request when it is lost or out (`docs/runbooks/rotation.md`, section 14).
- **The service account** in the association's Google Cloud project, whose JSON key EAS holds for its submissions. In Play Console it may view this app and release it to testing tracks; the same permission lets it upload to internal app sharing, which takes a bundle signed with any key. EAS uses the key for any holder of `EXPO_TOKEN`, so its trust is the update path's: write access (ADR-004 §3, ADR-057 §3).

Play's copy of the app and an APK from expo.dev are signed with different keys, so neither installs over the other: a phone uninstalls one to take the other, and loses the app's local data, the session among it.

## Android developer verification

Since 30 September 2026 every app on Google Play is to be registered to its developer, by package name and signing keys, under Android developer verification in Play Console, and an app that is not is to be removed. Creating an app registers its name; Play's keys follow at its first upload. Google's checks on phones go further: from 30 September 2026 in Brazil, Indonesia, Singapore and Thailand for installs from participating stores, and from 2027 everywhere, sideloaded APKs included; no date for Finland is announced. An install through `adb` is exempt. So EAS's key is registered beside Play's as the key of the builds outside Play, and the expo.dev APKs stay installable when the checks arrive.

A name already installed on certified phones before the Play app existed counts as known, and Create app refuses it until the account proves it holds a signing key for the name: below 50 known installs any key will do, and the first to register wins. `fi.kuutti.app` may be one, through the team's APKs, and the key to prove it with is EAS's. The proof is a release APK signed with that key that carries the console's token (step 2).

## What the association sets up, the maintainer's

1. **Create the app.** Play Console, Home, Create app: the name Kuutti; the package name `fi.kuutti.app`, which can never change; Finnish as the default language, the binding one (TD-17); an app, free; `hello@kuutti.app` as the contact e-mail; the declarations. If Create app refuses the name as not registered, do step 2 first. Then, before any release, automatic protection off (ADR-057 §9): Test and release, App integrity (now Protected with Play), Automatic protection, off for the app, and Share app telemetry with Google off. If the console offers only the per-release switch, say so in #193: every bundle EAS submits would then be protected.
2. **Prove the name, only if step 1 refused it.** Android developer verification, Register package name: `fi.kuutti.app` and a friendly name, then Add key with EAS's SHA-256 (expo.dev, the project's Credentials, Android, `fi.kuutti.app`; or `eas credentials -p android`), then Upload APK, which shows a snippet. The proof APK is built on EAS so the private key never leaves it, from a local branch that is never pushed:
   - a plugin writes the snippet, and nothing else, as the whole of `assets/adi-registration.properties`:
     ```js
     // plugins/withAdiRegistration.js, on the local branch only
     const { withDangerousMod } = require("expo/config-plugins");
     const { mkdirSync, writeFileSync } = require("node:fs");
     const { join } = require("node:path");
     module.exports = (config) =>
       withDangerousMod(config, ["android", async (mod) => {
         const assets = join(mod.modRequest.platformProjectRoot, "app/src/main/assets");
         mkdirSync(assets, { recursive: true });
         writeFileSync(join(assets, "adi-registration.properties"), "<the snippet>\n");
         return mod;
       }]);
     ```
   - `"./plugins/withAdiRegistration.js"` added to the plugins of `app.json`, the two committed on that branch, then `eas build --profile preview --platform android` in `apps/mobile`: a release APK signed with EAS's key, one of the month's 15 builds;
   - the build page's APK uploaded at Upload APK. Google mails a confirmation. Delete the branch, and do step 1 again.
3. **The testers, before any key exists.** Two lists of the team's Google accounts, the team alone (ADR-057 §2):
   1. Test and release, Testing, Internal testing, Testers: an e-mail list, at most 100;
   2. Test and release, Internal testing, Internal app sharing, Manage testers: Link availability, Email lists, that list, in place of "Anyone you shared the link with". Internal app sharing takes a bundle signed with any key, and the service account's permission reaches it (ADR-057 §3). This list bounds whose phone such a bundle reaches, and while the app is on internal testing alone the first one does too: a tester also needs access to the app's store listing, and internal app sharing switched on in the Play Store app.
4. **The service account**, in the association's organisation, with `gcloud` signed in as the owner login. `<org>` is the organisation's id (`gcloud organizations list`), `<project>` the new project's; on 2026-10-27 they were made as the project `kuutti-play` and its service account `eas-submit`. The owner login is Organization Administrator, which may grant the policy role but does not hold it:
   ```sh
   # once, if the login lacks it: the role that lifts an organisation policy
   gcloud organizations add-iam-policy-binding <org> --member=user:<owner login> --role=roles/orgpolicy.policyAdmin
   gcloud projects create <project> --organization=<org>
   gcloud services enable androidpublisher.googleapis.com --project=<project>
   gcloud iam service-accounts create eas-submit --project=<project> --display-name="EAS Submit to Google Play"
   ```
   The service account needs no IAM role. An organisation made on or after 3 May 2024, as the Workspace's would be, refuses service account keys by default, under two constraints, `iam.managed.disableServiceAccountKeyCreation` and the legacy `iam.disableServiceAccountKeyCreation`. `gcloud org-policies describe <constraint> --organization=<org> --effective` says which the organisation enforces; on 2026-10-27 it was the managed one alone. The maintainer lifts each one enforced, for this project alone, with a file of its own and `gcloud org-policies set-policy <file>`:
   ```yaml
   name: projects/<project>/policies/<constraint>
   spec:
     rules:
       - enforce: false
   ```
   Then the maintainer makes the key, outside the checkout, since `eas credentials` offers the JSON files it finds in the project's directory, and nobody else sees the file:
   ```sh
   gcloud iam service-accounts keys create ~/eas-submit.json --iam-account=eas-submit@<project>.iam.gserviceaccount.com
   ```
   It is uploaded at expo.dev (the project's Credentials, Android, `fi.kuutti.app`, Service credentials, the Google service account key for EAS Submit) or with `eas credentials -p android`. Then `rm ~/eas-submit.json`, and the policy goes back with `gcloud org-policies delete <constraint> --project=<project>` for each one lifted, since a rotation lifts it again.

   Last, in Play Console, Users and permissions, Invite new users: the service account's e-mail address, with App permissions on Kuutti alone: View app information, Release apps to testing tracks, and Edit and delete draft apps while the app is a draft; no account permission. A permission can take up to 48 hours to reach the API, so invite it before the first build.

   The key must be in EAS before the first build: without it, `eas build --auto-submit` fails the job after the build has been queued, and the bundle reaches nobody.
5. **The first bundle**, once steps 3 and 4 are done and the `staging` profile is on `main`: `gh workflow run eas-build.yml --ref main -f profile=staging`. EAS builds it and submits it, and the submission's page on expo.dev, linked from the build, says how it went. If it failed with "Package not found" or the draft-app message, download the `.aab` from the build page, and in Internal testing, Create new release: upload it, keep the signing keys Google offers, Next, then Save and publish. If Play offers Save alone, the release would go to review: check first that the app's setup is still incomplete. Leave the store listing and the app content for after this first rollout: if the app's setup is complete when it rolls out, Google reviews it first, for hours or a week. Should Play want a privacy policy before it takes the bundle, see When something goes wrong.
6. **Install.** Internal testing, Testers, Copy link: it appears once a release has rolled out, and may take hours to work. Each tester opens it with their listed Google account, accepts, and installs from Play, after uninstalling an expo.dev APK of Kuutti.
7. **EAS's key, beside Play's.** Android developer verification, `fi.kuutti.app`, Add key: EAS's SHA-256, unless step 2 registered it already. If the console asks for an APK, it is step 2's.
8. **The fingerprints.** Manage Play app signing (The keys, above): Play's three SHA-256 fingerprints, for #184's `assetlinks.json` beside EAS's. Then check under Android developer verification, Package names, that Play's keys are listed for `fi.kuutti.app` beside EAS's.

From then on every start of the `staging` profile should reach the testers without a click. No source has shown yet that Google takes a completed release on an app whose setup is incomplete. If the draft-app message comes back, or the Testers tab shows no link, set `releaseStatus` to `draft` in the submit profile `staging`, and roll each release out in the console until #188's setup is done.

## Before a closed track (#193, #188)

None of this is needed for internal testing, and all of it is for a closed or public one, which Google reviews:

- the store listing: a 512 by 512 icon, a 1024 by 500 feature graphic, at least two screenshots (each within the console's own limits, which for the developer page were stricter than Google's help), a short description of at most 80 characters, in Finnish, Swedish and English (#193), and the Dating category;
- the app content: the privacy policy (#190), the sign-in details for the reviewers, which bank identification cannot give (#299), no ads, the content rating questionnaire, the target audience 18 and over only with minors' access restricted (Google's policy for dating apps, since October 2025), the data safety form with a web link where an account's deletion is asked, and the child safety standards: a public page on `kuutti.app` against child sexual abuse and exploitation that names the app, the in-app reporting, and a named point of contact (#188);
- the production build itself (ADR-057 §7).

## When something goes wrong

- **`eas build` fails at once with "Google Service Account Keys cannot be set up in --non-interactive mode":** EAS has no key for `fi.kuutti.app`. The build was queued anyway and runs without a submission. Upload the key (step 4), then `eas submit --platform android --profile staging --id <build id>` in `apps/mobile`.
- **The submission fails with "Package not found":** Google's API does not know the app yet. Upload that bundle by hand once (step 5).
- **"Only releases with status draft may be created on draft app":** the app has never been published. Roll out one release by hand (step 5); if the message comes back after that, submit as `draft` until the setup is done (after step 8).
- **Play refuses the bundle until a privacy policy is set:** a permission the bundle requests needs one. Enter the site's privacy notice (#190) under App content, Privacy policy; one entry does not complete the setup, so the release is still not reviewed. Then `eas submit --platform android --profile staging --id <build id>`.
- **The build fails in Run gradlew, at Sentry's source-map upload, with `error: organization not found`:** the `SENTRY_AUTH_TOKEN` in EAS's `preview` environment predates Sentry's present organisation name, and an organisation token carries the slug it was made under. Development builds skip the upload, so a release build is the first to fail, as the first `staging` build did on 2026-10-27; the deprecation warnings above the failure are not it. Make the token again and set it from `apps/mobile` with `pnpm exec eas env:set --environment preview --name SENTRY_AUTH_TOKEN --visibility secret`, the value at the prompt (`docs/runbooks/sentry-setup.md`, section 4).
- **`eas` asks which account should own the project:** it ran outside `apps/mobile`, where it finds no `app.json`. Linking there writes an `app.json` of its own at that place, to delete. Run `eas` from `apps/mobile`.
- **The version code is already used:** a bundle with that number was uploaded before. Build again; EAS counts up.
- **The caller does not have permission:** the service account's invitation has not reached the API yet (up to 48 hours), or lacks Release apps to testing tracks.
- **A bad release:** an internal testing release cannot be halted. Revert the change on `main` and start the `staging` profile again: the new bundle's higher version code replaces the bad one on the testers' phones. On a closed or open track, halt its rollout in Play Console. A bad JavaScript update is stopped at EAS, not in the store (ADR-004, `docs/runbooks/incident.md`).

A failed submission shows on its page on expo.dev and in `eas submit:list --status errored`. GitHub shows nothing: the job ended when the build was queued.

## Sources, read on 2026-10-27

- Google, Android developer verification: https://developer.android.com/developer-verification/guides/google-play-console (updated 2026-09-30), https://developer.android.com/developer-verification/guides/faq, https://support.google.com/googleplay/android-developer/answer/16984799 (registering Play package names), https://support.google.com/googleplay/android-developer/answer/16761055 (the proof APK).
- Google Play: https://support.google.com/googleplay/android-developer/answer/9859152 (Create app), https://support.google.com/googleplay/android-developer/answer/9845334 (testing tracks), https://support.google.com/googleplay/android-developer/answer/9844679 (internal app sharing), https://support.google.com/googleplay/android-developer/answer/16285429 (halting a release), https://support.google.com/googleplay/android-developer/answer/10183279 (automatic protection), https://support.google.com/googleplay/android-developer/answer/9842756 (Play App Signing), https://support.google.com/googleplay/android-developer/answer/9873827 (the developer profile), https://developers.google.com/android-publisher/getting_started (the service account).
- Google Cloud: https://cloud.google.com/resource-manager/docs/secure-by-default-organizations and https://cloud.google.com/resource-manager/docs/organization-policy/using-constraints (both updated 2026-10-22).
- Expo: https://docs.expo.dev/submit/android/ (updated 2026-10-09), https://expo.fyi/creating-google-service-account (2026-07-17).
