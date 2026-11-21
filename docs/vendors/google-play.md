# Google Play (Google)

What Google Play is to Kuutti, and what Google receives through it. Since 2026-10-27 the association has an organisation developer account on Google Play, with the developer name Kuutti ry, owned by the maintainer's login at the association's Google Workspace (`docs/runbooks/custody.md`). The app is `fi.kumpa`, Kumpa, since #184's native batch (ADR-057 §10). Until then it was `fi.kuutti.app`, Kuutti, which stays in the account with its internal testing track: what this file says happened on a day in October or on 1 November 2026 happened to that app, and the steps below are walked again for `fi.kumpa`, all but the Google Cloud project and its service account (step 4), which are the account's. Two tracks are in use: internal testing, which carries the staging app to the team (ADR-057), and since 2026-11-18 a closed test, which took the same staging bundle through Google's first review (The closed test, below). No credentials in this file, and no address but the public ones.

## What Play shows of the association

Play Console's Play developer profile lists as public account details the organisation's name Kuutti ry, its registered address (public on `kuutti.app` too), the developer phone number of the account and the developer e-mail `hello@kumpa.fi`, the website's address (`hello@kuutti.app` until 2026-11-21, when the maintainer changed it in the console). They come from the account details Google verified, and change there. Once the app is listed, its page and the developer page show them, with the website `https://kuutti.app/`. Until then nothing public shows them: a closed test has no public page, and the developer page needs a published app. Kumpa's own listing names `https://kumpa.fi/` as its website and `hello@kumpa.fi` as its contact, changed in the console the same day.

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
| The closed test's list: the addresses of its testers' Google accounts, kept by hand in the console | who may opt in and install the closed test |
| Since 2026-11-18: the store listing, the content rating, the target audience (18 and over only), the data safety form, the child safety declaration and the reviewers' way in | Play's review and the store page (#188, #299, #560) |

From the phones, Play itself records installs and updates and, on phones whose owners share usage and diagnostics with Google, crashes and freezes (Android vitals). The app adds no Google library of its own: `expo-application`, which Expo's own modules pull in, carries Google's install-referrer client, which the app asks once, on the phone, for an invitation's code (ADR-074 §4). Nor does Play add one, while its automatic protection is off (ADR-057 §9). Google's pre-launch robots also run each uploaded bundle on test phones; in the staging app they stop at the bank login, which they cannot pass.

## The keys

- **The app signing keys**, generated and held by Google (Play App Signing). For a new app in 2026 that is a hybrid set: an RSA key for Android 16 and lower, a classical key and an ML-DSA key for Android 17 and later. Every install from Play carries them, and nobody at Kuutti holds a copy. Their SHA-256 fingerprints are in Play Console under Protected with Play, Play Store protection, Manage Play app signing (older guides say Setup, App integrity); verified links (#184) need all three. Until a release reaches open testing or production, the maintainer may still change them to the association's own key (ADR-057, Open 1).
- **The upload key**: EAS's keystore of `fi.kumpa`, a new one unless `fi.kuutti.app`'s was assigned to it before its first build (ADR-057 §10), which also signs the development and preview APKs. Play takes a bundle for a track only with its signature. EAS hands it to every cloud build, so to any holder of `EXPO_TOKEN` too. Google resets it on request when it is lost or out (`docs/runbooks/rotation.md`, section 14).
- **The service account** in the association's Google Cloud project, whose JSON key EAS holds for its submissions. In Play Console it may view this app and release it to testing tracks; the same permission lets it upload to internal app sharing, which takes a bundle signed with any key. EAS uses the key for any holder of `EXPO_TOKEN`, so its trust is the update path's: write access (ADR-004 §3, ADR-057 §3). The owner login may also act as it, an hour at a time and without a key (Reading Play from the command line, below). While Kumpa was a draft the service account could also write the listing; since the closed test was published on 2026-11-18 it cannot (Writing the listing, below).

Play's copy of the app and an APK from expo.dev are signed with different keys, so neither installs over the other: a phone uninstalls one to take the other, and loses the app's local data, the session among it.

## Android developer verification

Since 30 September 2026 every app on Google Play is to be registered to its developer, by package name and signing keys, under Android developer verification in Play Console, and an app that is not is to be removed. Creating an app registers its name; Play's keys follow at its first upload. Google's checks on phones go further: from 30 September 2026 in Brazil, Indonesia, Singapore and Thailand for installs from participating stores, and from 2027 everywhere, sideloaded APKs included; no date for Finland is announced. An install through `adb` is exempt. So EAS's key is registered beside Play's as the key of the builds outside Play, and the expo.dev APKs stay installable when the checks arrive.

A name already installed on certified phones before the Play app existed counts as known, and Create app refuses it until the account proves it holds a signing key for the name: below 50 known installs any key will do, and the first to register wins. `fi.kuutti.app` may have been one, through the team's APKs. `fi.kumpa` is not while the app is created in the console before any build of it reaches a phone, which is the order to keep. The key to prove a name with is EAS's. The proof is a release APK signed with that key that carries the console's token (step 2).

## What the association sets up, the maintainer's

1. **Create the app.** Play Console, Home, Create app: the name Kumpa; the package name `fi.kumpa`, which can never change; Finnish as the default language, the binding one (TD-17); an app, free; `hello@kumpa.fi`, the website's address, as the contact e-mail (`hello@kuutti.app` when Kumpa was created); the declarations. If Create app refuses the name as not registered, do step 2 first. Then, before any release, automatic protection off (ADR-057 §9): Test and release, App integrity (now Protected with Play), Automatic protection, off for the app, and Share app telemetry with Google off. If the console offers only the per-release switch, say so in #193: every bundle EAS submits would then be protected.
2. **Prove the name, only if step 1 refused it.** Android developer verification, Register package name: `fi.kumpa` and a friendly name, then Add key with EAS's SHA-256 (expo.dev, the project's Credentials, Android, `fi.kumpa`; or `eas credentials -p android`), then Upload APK, which shows a snippet. The proof APK is built on EAS so the private key never leaves it, from a local branch that is never pushed:
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
   1. Test and release, Testing, Internal testing, Testers: an e-mail list, at most 100, ticked in the Testers table and saved;
   2. Test and release, Setup, Internal app sharing (Google's help also gives Test and release, Internal testing, Internal app sharing), Manage testers: Restrict access to email lists, as the console labels it, and that list, in place of the default "Anyone you shared the link with can download". Internal app sharing takes a bundle signed with any key, and the service account's permission reaches it (ADR-057 §3). The testers' list bounds whose phone such a bundle reaches, and while the app is on internal testing alone the first one does too: a tester also needs access to the app's store listing, and internal app sharing switched on in the Play Store app (Settings, About, Play Store version tapped seven times, then the switch in Settings). Manage uploaders stays empty: whoever may release to testing tracks may upload there already, the owner login and the service account among them, and a listed uploader need not be a Play Console user at all. On 2026-10-28, a day after the key, the page still stood at the default with no list, and the team's list was under Manage uploaders; the maintainer restricted the testers to the team's list and emptied Manage uploaders that day.
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
   It is uploaded at expo.dev (the project's Credentials, Android, `fi.kumpa`, Service credentials, the Google service account key for EAS Submit) or with `eas credentials -p android`. EAS keeps a key for the account and attaches it to an application identifier, so for `fi.kumpa` the key it already holds is attached there with `eas credentials -p android` (Google Service Account, the existing key), a person at the keyboard, and no new one is made. Then `rm ~/eas-submit.json`, and the policy goes back with `gcloud org-policies delete <constraint> --project=<project>` for each one lifted, since a rotation lifts it again.

   Last, in Play Console, Users and permissions, Invite new users: the service account's e-mail address (for `fi.kumpa` the user is there already, and gets the app), with App permissions on Kumpa alone: View app information, Release apps to testing tracks, and Edit and delete draft apps while the app is a draft, taken away again once Play no longer shows it as one; no account permission. A permission can take up to 48 hours to reach the API, so invite it before the first build.

   The key must be in EAS before the first build: without it, `eas build --auto-submit` fails the job after the build has been queued, and the bundle reaches nobody.
5. **The first bundle**, once steps 3 and 4 are done and the `staging` profile is on `main`: `gh workflow run eas-build.yml --ref main -f profile=staging`. EAS builds it and submits it, and the submission's page on expo.dev, linked from the build, says how it went. On 2026-10-27 it went through: Google took version code 3 as a completed release on the internal testing track while the app was a draft, its setup incomplete. If a submission fails with "Package not found" or the draft-app message, download the `.aab` from the build page, and in Internal testing, Create new release: upload it, keep the signing keys Google offers, Next, then Save and publish. If Play offers Save alone, the release would go to review: check first that the app's setup is still incomplete. Leave the store listing and the app content for after this first rollout: if the app's setup is complete when it rolls out, Google reviews it first, for hours or a week. Should Play want a privacy policy before it takes the bundle, see When something goes wrong.
6. **Install.** Internal testing, Testers, Copy link: it appears once a release has rolled out, and may take hours to work. Each tester opens it with their listed Google account, accepts, and installs from Play, after uninstalling an expo.dev APK of Kumpa; a copy of `fi.kuutti.app` is another app to the phone, and stays until its owner removes it. Until the app's first review Play shows it under a temporary name, its package name with "(unreviewed)". On 2026-10-28 a tester installed version code 3 this way.
7. **EAS's key, beside Play's.** Android developer verification, `fi.kumpa`, Add key: EAS's SHA-256, unless step 2 registered it already. If the console asks for an APK, it is step 2's.
8. **The fingerprints.** Manage Play app signing (The keys, above): Play's three SHA-256 fingerprints, for #184's `assetlinks.json` beside EAS's. Then check under Android developer verification, Package names, that Play's keys are listed for `fi.kumpa` beside EAS's.

From then on every start of the `staging` profile reaches the testers without a click, since Google takes a completed release on the app while its setup is incomplete (step 5). Should Google answer a submission with the draft-app message, set `releaseStatus` to `draft` in the submit profile `staging`, and roll each release out in the console until #188's setup is done.

## Reading Play from the command line

The Play Developer API says what each track holds, without the console. The owner login may act as the service account for an hour at a time, with no key file: on 2026-10-28 the project got the IAM Service Account Credentials API (switched on by the agent, at the maintainer's asking), and the maintainer granted his login Service Account Token Creator on `eas-submit`:

```sh
gcloud services enable iamcredentials.googleapis.com --project=kuutti-play
gcloud iam service-accounts add-iam-policy-binding eas-submit@kuutti-play.iam.gserviceaccount.com --project=kuutti-play --member=user:<owner login> --role=roles/iam.serviceAccountTokenCreator
```

The grant is the maintainer's, like step 4; an agent may run the read below at his asking, with his session. A token carries the service account's rights alone, for its hour: releasing this app on its testing tracks, uploading a bundle signed with any key to internal app sharing, and editing the app while it is a draft. Unlike a key it leaves nothing to find later: Google records the minting only in Data Access audit logs, which are off unless switched on, for the IAM API, in the project.

The read opens an edit, reads the tracks and deletes the edit without committing it, so the app does not change. But an account may have only one edit open, and a new one invalidates the last: never run it while an EAS submission is under way, or the submission fails. gcloud copies what it prints into its log files (`~/.config/gcloud/logs`, kept 30 days and more widely readable than its credentials), so the token's call runs with file logging off, and the token reaches `curl` on its standard input, never in a command line:

```sh
a=https://androidpublisher.googleapis.com/androidpublisher/v3/applications/fi.kumpa
h="Authorization: Bearer $(CLOUDSDK_CORE_DISABLE_FILE_LOGGING=true gcloud auth print-access-token --impersonate-service-account=eas-submit@kuutti-play.iam.gserviceaccount.com --scopes=https://www.googleapis.com/auth/androidpublisher 2>/dev/null)"
e=$(printf '%s\n' "$h" | curl -s -X POST -H @- "$a/edits" | jq -r .id)
printf '%s\n' "$h" | curl -s -H @- "$a/edits/$e/tracks" | jq -c '.tracks[] | select(.releases) | {track, releases}'
printf '%s\n' "$h" | curl -s -o /dev/null -X DELETE -H @- "$a/edits/$e"
unset h e
```

On 2026-10-28 it showed `{"track":"internal","releases":[{"name":"0.0.0","versionCodes":["3"],"status":"completed"}]}`. A release's status is `completed`, `draft`, `inProgress` or `halted` (`statusUnspecified` when none is set). The API knows testers only as Google Groups: the e-mail lists, internal app sharing's settings and the opt-in link (step 6) are the console's alone. `--scopes` is a hidden flag of `print-access-token` in gcloud 590, which warns that it is ignored for an impersonated account and applies it all the same. The login's gcloud session asks to be signed in again after some hours (by the next morning, on 2026-10-28): `gcloud auth login`, in a terminal of the maintainer's.

### Writing the listing

While Kumpa was a draft, the same token wrote its listing: the edit's `details` (the contact), `listings/en-GB` (the name and the descriptions) and the images (`icon`, `featureGraphic` and `phoneScreenshots`, each a POST of the file to `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/fi.kumpa/edits/<edit>/listings/en-GB/<kind>?uploadType=media`), then `POST $a/edits/${e}:commit`. In zsh the braces matter: `$e:commit` is read as a modifier of `$e`, eats the `c`, and Google answers with a 404 page.

Since the closed test was published (2026-11-18) the API refuses both ways of committing a listing change, and the edit is deleted with nothing changed:

- with `changesNotSentForReview=true`: "Changes are sent for review automatically. The query parameter changesNotSentForReview must not be set.";
- without it: "The caller does not have permission". The service account may release to testing tracks and no more (step 4), and the store presence of a published app is beyond that. Whether it gets a permission for it is the maintainer's; until then a listing change is made in the console.

In the console the listing is at `https://play.google.com/console/u/<n>/developers/<developer id>/app/<app id>/store-listings`, and the page with the texts and the screenshots at `…/store-listings/default/edit`. Other pages of the app end `app-dashboard`, `publishing` (Publishing overview), `app-content/overview` and `test-and-release`.

The grant goes with `gcloud iam service-accounts remove-iam-policy-binding eas-submit@kuutti-play.iam.gserviceaccount.com --project=kuutti-play --member=user:<owner login> --role=roles/iam.serviceAccountTokenCreator`, read back with `gcloud iam service-accounts get-iam-policy eas-submit@kuutti-play.iam.gserviceaccount.com --project=kuutti-play`. A token minted before it went works until its hour is out.

## The closed test (#193, #188, #560)

Internal testing needs none of this. A closed or public track does, and Google reviews it. On 2026-11-18 it was all filled for Kumpa and sent, so that the reviewers' way in (#560) and the forms of #188 met Google once before the production submission. What was sent is the staging bundle, as #560's comment of 2026-11-05 chose for the review build: every person in it is invented, and the bank is the broker's test bank.

**The store listing**, in English (U.K.) alone, the app's default language (Finnish, step 1's, was not chosen for Kumpa; the Finnish and Swedish listings wait for #55 and #413):

| Field | What it holds |
|---|---|
| Name | Kumpa |
| Short description, at most 80 characters | "Dating for Finland, run by a non-profit. Every account verified by bank ID." |
| Full description | an opening line, five short points and a closing line: the App Store's text (`docs/vendors/app-store.md`) |
| Icon, 512 by 512 | the app's own icon, a placeholder |
| Feature graphic, 1024 by 500 | a placeholder |
| Phone screenshots, 1080 by 1920 | five real screens of the staging app with a caption each, placeholders until #413: the bank sign-in, what you seek, a conversation, your profile, settings |
| Contact | `hello@kumpa.fi` (`hello@kuutti.app` until 2026-11-21, changed in the console), `https://kumpa.fi/` |
| Category | Dating |

The listing's last step, Review, asks for the AI asset declaration: "Don't label assets", or "Label assets as created or edited using AI", then asset by asset. One of the screenshots holds a generated picture.

**App content.** The console keeps these pages under Monitor and improve, Policy and programs. As answered:

| Page | Answer |
|---|---|
| Privacy policy | `https://kumpa.fi/legal/privacy/` |
| Ads | No, the app contains no ads |
| Content rating | category Social or Communication, best described as Social; users' precise location shared with others: no; digital purchases: no; users can block: yes; users can report: yes; chat is moderated: yes; limited to invited friends: no. The same answers gave `fi.kuutti.app` PEGI 18, USK 18+, ESRB Mature 17+ and IARC 18+ on 2026-11-01 |
| Target audience and content | 18 and over only, with minors' access restricted (Google's policy for dating apps, since October 2025) |
| Data safety | imported as a CSV file the maintainer keeps: 17 data types, all collected, none shared; encrypted in transit; an account is created through "Other", strong electronic identification through a Finnish bank; deletion is asked at `https://kumpa.fi/delete-account/` |
| Government apps | No |
| Financial features | None |
| Health | No health features |
| Advertising ID | No |
| Sign in details | all or some functionality is restricted; two sets, each a user ID of the broker's test bank with an empty password: a member with a history (`DEMOUSER4`, Sanna) and, as saved, a new member (`DEMOUSER1`, Onni), who since #560 is a member with a history too, the form's wording waiting for the page's next change; with the steps in English (`docs/runbooks/store-review.md`) |
| Child safety standards | the published standards at `https://kumpa.fi/child-safety/`, the in-app reporting, a named point of contact, and the self-certification (#188) |

While a page is unsaved the app's setup is incomplete, and nothing is reviewed by itself (ADR-057 §6); the last pages were saved only when the review was wanted.

**The track.** Test and release, Testing, Closed testing: the track the console calls "Closed testing - Alpha" (`alpha` in the API), Finland as its one country, one e-mail list of testers, and a release made from the bundle already on internal testing, "2 (0.127.0)", version code 2. Publishing overview then showed thirteen changes, which the maintainer sent for review. Google approved them the same day.

**Managed publishing.** Before the first approval the console refused it ("You can't turn on managed publishing right now"). Once the review had passed it was on, the changes waited under "Changes ready to publish", and the maintainer published them. It stays on: an approved change reaches nobody until a person publishes it, which the production submission needs (ADR-057 §7). A later change of the listing, the five captioned screenshots, was saved in the console that afternoon and went the same way.

**The testers.** Closed testing, Testers has the opt-in link. Each tester opens it with a listed Google account, as in step 6.

Not yet seen: whether a staging bundle that EAS submits to internal testing now waits for Google, or for a person to publish it, since the setup is complete and managed publishing is on (step 5, and the last paragraph of What the association sets up). The next start of the `staging` profile shows it, on the submission's page on expo.dev and in Publishing overview.

## Before production (#193)

- the listing in Finnish, Swedish and English with the real screenshots and feature graphic (#413, #55);
- Sign in details read again and reworded (`docs/runbooks/store-review.md`, What the forms say);
- the production build itself (ADR-057 §7), with managed publishing on.

## When something goes wrong

- **`eas build` fails at once with "Google Service Account Keys cannot be set up in --non-interactive mode":** EAS has no key for the application identifier, as for `fi.kumpa` before step 4 is done for it. The build was queued anyway and runs without a submission. Upload the key (step 4), then `eas submit --platform android --profile staging --id <build id>` in `apps/mobile`.
- **The submission fails with "Package not found":** Google's API does not know the app yet. Upload that bundle by hand once (step 5).
- **"Only releases with status draft may be created on draft app":** Google is taking only draft releases for the app; on 2026-10-27 it took a completed one (step 5). Roll out one release by hand (step 5); if the message comes back after that, submit as `draft` until the setup is done (after step 8).
- **Play refuses the bundle until a privacy policy is set:** a permission the bundle requests needs one. Enter the site's privacy notice (#190) under App content, Privacy policy; one entry does not complete the setup, so the release is still not reviewed. Then `eas submit --platform android --profile staging --id <build id>`.
- **The build fails in Run gradlew, at Sentry's source-map upload, with `error: organization not found`:** the `SENTRY_AUTH_TOKEN` in EAS's `preview` environment predates Sentry's present organisation name, and an organisation token carries the slug it was made under. Development builds skip the upload, so a release build is the first to fail, as the first `staging` build did on 2026-10-27; the deprecation warnings above the failure are not it. Make the token again and set it from `apps/mobile` with `pnpm exec eas env:set --environment preview --name SENTRY_AUTH_TOKEN --visibility secret`, the value at the prompt (`docs/runbooks/sentry-setup.md`, section 4).
- **`eas` asks which account should own the project:** it ran outside `apps/mobile`, where it finds no `app.json`. Linking there writes an `app.json` of its own at that place, to delete. Run `eas` from `apps/mobile`.
- **The version code is already used:** a bundle with that number was uploaded before. Build again; EAS counts up.
- **The caller does not have permission:** the service account's invitation has not reached the API yet (up to 48 hours), or lacks Release apps to testing tracks. On the commit of a listing change it means the app is no longer a draft (Writing the listing).
- **"You can't turn on managed publishing right now":** the app has not passed its first review. Send the changes, and switch it on once they are approved (The closed test).
- **A reviewer cannot sign in:** `docs/runbooks/store-review.md`, If a reviewer cannot get in.
- **A bad release:** an internal testing release cannot be halted. Revert the change on `main` and start the `staging` profile again: the new bundle's higher version code replaces the bad one on the testers' phones. On a closed or open track, halt its rollout in Play Console. A bad JavaScript update is stopped at EAS, not in the store (ADR-004, `docs/runbooks/incident.md`).

A failed submission shows on its page on expo.dev and in `eas submit:list --status errored`. GitHub shows nothing: the job ended when the build was queued.

## Sources, read on 2026-10-27

The closed test, Writing the listing and the console's paths are what the console and the API showed on 2026-11-18, not Google's documentation.

- Google, Android developer verification: https://developer.android.com/developer-verification/guides/google-play-console (updated 2026-09-30), https://developer.android.com/developer-verification/guides/faq, https://support.google.com/googleplay/android-developer/answer/16984799 (registering Play package names), https://support.google.com/googleplay/android-developer/answer/16761055 (the proof APK).
- Google Play: https://support.google.com/googleplay/android-developer/answer/9859152 (Create app), https://support.google.com/googleplay/android-developer/answer/9845334 (testing tracks), https://support.google.com/googleplay/android-developer/answer/9844679 (internal app sharing), https://support.google.com/googleplay/android-developer/answer/16285429 (halting a release), https://support.google.com/googleplay/android-developer/answer/10183279 (automatic protection), https://support.google.com/googleplay/android-developer/answer/9842756 (Play App Signing), https://support.google.com/googleplay/android-developer/answer/9873827 (the developer profile), https://developers.google.com/android-publisher/getting_started (the service account).
- Google Cloud: https://cloud.google.com/resource-manager/docs/secure-by-default-organizations and https://cloud.google.com/resource-manager/docs/organization-policy/using-constraints (both updated 2026-10-22).
- Expo: https://docs.expo.dev/submit/android/ (updated 2026-10-09), https://expo.fyi/creating-google-service-account (2026-07-17).
- Read on 2026-10-28, for internal app sharing's page and Reading Play from the command line: https://support.google.com/googleplay/android-developer/answer/9844679 (internal app sharing: its paths, uploaders by default, the Play Store switch), https://developers.google.com/android-publisher/edits (one open edit per account), https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks (a release's status), https://developers.google.com/android-publisher/api-ref/rest/v3/edits.testers (testers as Google Groups), https://docs.cloud.google.com/iam/docs/service-account-impersonation (Token Creator, short-lived tokens), https://docs.cloud.google.com/iam/docs/audit-logging/audit-logging-iamcreds (the minting as a Data Access log).
