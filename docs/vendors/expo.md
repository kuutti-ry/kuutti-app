# Expo (650 Industries, Inc.)

What Expo is to Kuutti, and what it receives. Expo builds the app (EAS Build), delivers its JavaScript updates (EAS Update, ADR-004) and, since #102, carries its pushes (ADR-055). The project is `kuutti` under the account `kuutti` (`apps/mobile/app.json`, `owner` and `extra.eas.projectId`); the maintainer acts through the admin member `superseacat`, CI through a robot user's `EXPO_TOKEN`. No credentials in this file.

## The push service

The API sends each push to `https://exp.host/--/api/v2/push/send` (`apps/api/src/lib/push.ts`), up to a hundred a request; Expo hands each to Apple's push service (APNs) or Google's (FCM), which wake the phone. Expo's documentation of the service: https://docs.expo.dev/push-notifications/sending-notifications/.

### What Expo receives, per push

| What | Why |
|---|---|
| The Expo push token of one installation of the app | where the push goes; the token names an installation to Expo, Apple and Google, nothing about the person to them |
| One line of the app's own words, in the device's language: "You have a new message", "You have a new match" or "Today's round is ready" | what the phone shows |
| `data`: the kind, and for a message or a match the conversation's id (a random UUID) | what the app opens on a tap |
| `collapseId` and `tag`: the conversation's id, or `round` | so a later push replaces an earlier one of the same thing |
| `channelId` `default`, a priority, `sound: "default"`, for the round a time to live | how the phone shows it |
| When, and the API's address on the network | as for any request |

Never a message's text, a name, an account's id or anything of a profile; `apps/api/src/notifications/push.test.ts` fails on a payload that carries one. Apple and Google receive the same through Expo.

### What Expo keeps

- **Its policy** (https://expo.dev/privacy, "Last updated October 21st 2025") says Expo "may collect the end-users' push tokens", keeps information "only for so long as reasonably necessary", and that users outside the United States consent to transfer there. It says nothing of a push's content, its tickets or how long they are kept.
- **Receipts** are cleared after 24 hours (the push documentation above).
- **Its subprocessors** (https://expo.dev/privacy/subprocessors, "Last updated October 19, 2026") name Apple and Google, both in the United States, for push notifications.
- **Not found:** a data processing agreement, and where the push service runs. The association asks Expo for both before the app opens to people outside the team; until then the privacy policy says "Not stated by Expo in what the association has", as it does for updates.

### What the association sets up, the maintainer's

1. **Apple**: an APNs key (`.p8`) of the Apple Developer account, uploaded to EAS with `eas credentials` for `fi.kuutti.app`. Without it no push reaches an iPhone.
2. **Google**: a Firebase project with the Android app `fi.kuutti.app`, its FCM V1 service account key uploaded to EAS (`eas credentials`, Android, "Google Service Account Key For FCM V1"), and the project's `google-services.json` in the native build (`android.googleServicesFile` in `app.json`). Without the file an Android phone gets no Expo push token at all (the app logs the failure and tries again at its next start); the file names the Firebase project and is public by design, but adding it moves the fingerprint, so it belongs in the same native change as `expo-notifications` or costs one more build. Without the key no push reaches an Android phone; `MismatchSenderId` in a receipt means the key and the file are of different projects.
3. **Enhanced push security** in EAS (project settings), after step 4: Expo then refuses a push without the project's access token, so a token that leaked cannot be sent to by anybody but the API.
4. **The access token**, an Expo robot's, as the SecureString `/kuutti/<env>/expo-access-token` in each environment, made with the CLI and never a resource (ADR-001, `infra/README.md`); the API reads it as `EXPO_ACCESS_TOKEN` at boot and logs only whether it has one. Rotated by putting a new value and restarting the API.

`push` is `expo` in both environments' configuration (`infra/envs/*/main.tf`), so staging, its previews and production send; a development machine logs instead (`PUSH=log`), and `PUSH=expo` there sends for real to a dev client's token.

### When something goes wrong

- A ticket or receipt with `DeviceNotRegistered` deletes the token: the app was removed, or the phone no longer lets Kuutti notify. The app registers again at its next start if it may.
- `InvalidCredentials` (a receipt): the APNs key or the FCM key in EAS is wrong or gone; step 1 or 2 again.
- `MessageRateExceeded`, a 429 or a 5xx: nothing is retried (ADR-055 Open 4); the push is lost and the app shows everything when it opens. The API logs the code alone, never a token.
- `UNAUTHORIZED` for every push: enhanced push security is on and the environment has no access token, or a wrong one.

## EAS Build and EAS Update

The app's native builds and its updates: ADR-004 (what guards the update path), `apps/mobile/eas.json`, `docs/architecture/delivery.md`. At every start the app asks Expo's update service whether there is a newer version, which shows Expo the phone's address; the app sends nothing about the account there (the privacy policy, sections 6 and 7).
