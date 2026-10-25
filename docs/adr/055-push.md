# ADR-055: Push through Expo: that there is something, never what or from whom

- Status: proposed (#102, built as written here on the maintainer's answers of 2026-10-25 to the issue's four questions: the native module now, outside #184's batch; the message, the round and the match pushes in one change; the parameters as proposed; the site's privacy policy drafted here, its version his; the points under "Open, the maintainer's" are his to confirm or change)
- Date: 2026-10-25
- Follows: TD-3 (one box; push through Expo), TD-7 (what erasure deletes), TD-18 (no mail and no notice without a reason), ADR-007 §3 and §4 (export and erasure), ADR-011 §8 (a vendor's box and what it receives, the model for §8 here), ADR-022 §2 (a break revokes every session), ADR-024 (a sanction revokes the sessions), ADR-031 §5 and §9 (the live socket and who may read a message), ADR-032 (the switches this reads, and the permission line it left here), ADR-034 and ADR-035 (the round and its builder), ADR-038 (the match; its Open 1), ADR-045 (the app lock; its Open 1), CLAUDE.md rules 5 and 6, Product constraints (no real-time engagement push) and "Security and privacy defaults" (a new dependency); issues #102, #176, #184, #348, #349, #351, #384, #391, #409, #422

## Context

Nothing told a person that something had happened while the app was closed: a message, today's round, a match the other person made. ADR-032 built the switches per kind and left the push, and the line saying whether the phone lets Kuutti notify at all, to #102, which needs `expo-notifications`, a native module. The maintainer had put it with #184's native batch on 18/10/2026; on 25/10/2026 he chose to ship it now, as #422, #444 and #446 shipped theirs. He also chose that this change carries all three pushes (the message, the round, and the match for the person who did not make it), and confirmed the parameters the issue proposed.

A phone's lock screen is read by others, and a push travels through Expo, then Apple or Google. Whatever the payload carries, all of them learn.

## Decision

1. **The payload says that there is something, never what or from whom.** A push carries one line of the app's own words in the device's language (`push.message` "You have a new message", `push.match` "You have a new match", `push.round` "Today's round is ready"), no title, and `data` naming its kind and, for a message or a match, the conversation: `PushData` in `packages/schema/src/notifications.ts`, `{ kind: "message" | "match", conversationId }` or `{ kind: "round" }`. Never a message's text, a name, an account's id or anything of a profile (rule 5's reasoning, applied to a vendor); `push.test.ts` fails on a payload with any of them, with a fixture for each. No badge, ever (ADR-032 §4: no count). A message's and a match's push replace an earlier one of the same conversation on the phone (`collapseId` and Android's `tag` are the conversation's id, already in `data`), the round's the day's earlier one.
2. **A token per signed-in device.** `push_token(id, account_id, session_id, token, platform, locale, created_at)`, one generated migration (0081): `session_id` references `session` `ON DELETE CASCADE` and is unique, so a device has one token and it goes when its session row goes; `token` is unique, so a token belongs to one session. `platform` is `ios | android`; `locale` is the language the phone asked in when it registered, one of those the environment serves (`servedLocales`), which the push is worded in. `PUT /push-token` with `{ token, platform }` registers the caller's session's token and answers 204: it replaces the session's earlier token, and takes the token from any other session it was registered to, whichever account's, since the device now holds the caller's session (an app reinstalled without signing out keeps its token on iOS, and somebody else's pushes must not reach the next person to sign in on it). That one statement is the exception to rule 6's scoping, and it says why in place. The app registers on every start while the phone allows notifications, when the token changes, and when the person changes the app's language.
3. **A token goes when its session ends, whatever ends it.** A trigger deletes a session's token the moment its `revoked_at` is set (migration 0082, below): a sign-out, "sign out everywhere", the app lock's way out (ADR-045 §6), a sanction (ADR-024), a break (ADR-022 §2) and a refresh token's reuse all revoke, in three statements of the identity slice today and any later one. A session deleted (the night's prune, erasure) takes it by the cascade. A session that only expired keeps its row until the night's prune, and the sender reads tokens of live sessions only, so it gets nothing either. `eraseAccount` deletes the person's tokens itself and counts them (`ErasureSummary.pushTokens`). A paused, suspended or banned person therefore has no token, by construction.
4. **The message push.** After a message (text or photo) commits, the chat hands its conversation and sequence to the notifications slice through a callback `app.ts` gives `chatRoutes`, as the first-message check is handed (ADR-033), so the chat never imports notifications. The push goes to the other participant if, read fresh: they may read the message through their own participant row, by the socket's own rule (`messageReaders`, the chat's: nothing across a block or a close, nothing from a shadow-banned sender's withheld rows, nothing to an erased account); they have no live socket (`live.online`, #349), since the socket already delivers it to somebody in the app; their message switch is on (ADR-032); it is not the quiet hours; and no push of that conversation went to them within `message_push_min_interval_minutes`. The interval is kept in the process's memory, per recipient and conversation (`shortcut:` a restart forgets it, so the first message after one may push again early; a column on the token would lift it, if that is ever seen). The send's answer waits for the push's decision and its one request to Expo, at most five seconds; a failure is logged by its kind and changes no answer.
5. **The match push.** A like that makes a match (ADR-038) hands the new conversation to the notifications slice after it commits, through `Matches.made`, which `app.ts` gives the round's routes. The push goes to the person whose earlier like the match met, never to the one who just liked, who sees the match in the answer: if their match switch is on and it is not the quiet hours, whether or not they are in the app, since no socket frame tells of a new match (#389). This is the one push besides the round's and a message's, the maintainer's of 25/10/2026; `rules/mobile.md` says so. It answers ADR-038 Open 1 for the push; a notice in the app (ADR-032's `match` kind) stays open.
6. **The round push.** Once a day, at `round_push_hour` in Helsinki, everybody whose round for the Finnish day was built and not yet opened (`rounds.opened_at`), with a card that can still be shown, whose round switch is on, gets one push. Nobody else: not a person whose round is empty, nor one who opened it already, nor one with no round (production builds none yet, ADR-035's `shortcut:`). It lives with the jobs (`jobs/round-push.ts`), since it reads rounds, their entries, the switches and the tokens, on a timer of its own armed as the night's is, the hour read from `matching_config` at each arming. Its time to live ends with the day, so a phone that comes back tomorrow is not told of a round that is gone.
7. **The quiet hours.** No push of any kind from `push_quiet_from_hour` to `push_quiet_to_hour`, in Helsinki; equal hours mean none. Nothing is kept to send later: the person sees it all when they open the app (Open 1).
8. **Expo is a new recipient.** The API sends to Expo's push service (`https://exp.host/--/api/v2/push/send`), which hands each push to Apple's or Google's service. Expo receives, per push: the token, the line, `data`, and when. A token names an installation of the app on a device to Expo, Apple and Google, and nothing about the person to them; the API keeps it only to send. The Expo client is a seam (`lib/push.ts`, `Deps.pusher`): Expo's, a log of what would go (development and test only, as mail's), or none where `PUSH` is off, and a memory double in the tests. An access token for Expo's enhanced push security, once the maintainer switches it on in EAS, is the SecureString `/kuutti/<env>/expo-access-token`, made with the CLI and never a resource (ADR-001), read as `EXPO_ACCESS_TOKEN`; without it the requests go unauthenticated, which Expo accepts until the switch is on. Up to a hundred pushes a request, no retry (Open 4). A ticket or, read once fifteen minutes later from the process's memory, a receipt that says `DeviceNotRegistered` deletes its token; any other error is logged by its code alone (`shortcut:` a restart loses the receipts it was waiting for; a table of tickets would lift it). `docs/vendors/expo.md` says what Expo receives and keeps; the privacy policy's "Who else handles your data" gains the push in Expo's row and in Apple and Google's, and section 7 its line (the site, `kuutti-ry/kuutti-app-site`, under the version the maintainer gives it, ADR-010 §4). ADR-011 §8 is the model for the reasoning: a vendor gets what it needs to do its one job, and the association names it.
9. **The app asks once, when there is something to tell.** Never at the first start: the home screen offers it once the person's matching is open (the round's way in is there, and every match comes through a round), with the reason in words and two buttons, "Allow notifications", which shows the phone's own question, and "Not now", which the phone remembers (the preference `pushAsked`), so the app never offers it again. The phone's own refusal is remembered by the phone. Everything works without it. On Android the channel `default` is made before the phone is asked (Android 13 shows no question without one). A tap on a push opens its conversation or today's round. While the app is in front a push is shown as a banner and in the list, with no sound and no badge. The web target has none of it. Settings › Notifications says in words whether the phone lets Kuutti notify: allowed, not allowed with the way to the phone's settings (`Linking.openSettings`, on both platforms), or not asked yet, with a button that shows the phone's question, which on iOS is the only way the phone's settings ever get a Notifications row for Kuutti. No dialog of ours asks. The opening line no longer says that nothing is sent.
10. **The parameters**, version 1 rows of `matching_config` (migration 0082 and the seed's `MATCHING_CONFIG_V1`, held equal by `migrate.test.ts`): `message_push_min_interval_minutes` 10, `push_quiet_from_hour` 22, `push_quiet_to_hour` 8, `round_push_hour` 9, the issue's proposals that the maintainer confirmed on 25/10/2026.
11. **Erasure and export** (ADR-007 §3, §4). Erasure deletes the tokens (§3). The export lists the person's sessions as before, each with whether it receives pushes and, if it does, its platform, language and since when; never the token itself, which names the installation to Expo, Apple and Google and nothing to the person, and which a copy of the export in the wrong hands could send to.

Migration 0082 (`generate --custom`) holds what the schema DSL cannot say:

```sql
CREATE FUNCTION push_token_session_revoked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM push_token WHERE session_id = NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER session_revoked_push_token AFTER UPDATE OF revoked_at ON session
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION push_token_session_revoked();
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'message_push_min_interval_minutes', '10'::jsonb, 'migration:0082'),
  (1, 'push_quiet_from_hour', '22'::jsonb, 'migration:0082'),
  (1, 'push_quiet_to_hour', '8'::jsonb, 'migration:0082'),
  (1, 'round_push_hour', '9'::jsonb, 'migration:0082')
ON CONFLICT ("key", "version") DO NOTHING;
```

## Consequences

- `expo-notifications` in the app and its config plugin in `app.json`, with the Android notification icon from the monochrome icon (#409's placeholder): the native fingerprint moves for both platforms, every installed development build is orphaned a fourth time since #184 was written, and the maintainer dispatches a development build after the merge. The push needs Expo's credentials for Apple (an APNs key) and Google (an FCM V1 service account key) in EAS, the maintainer's (`docs/vendors/expo.md`).
- Routes: `PUT /push-token`. Contracts: `PushPlatform`, `PushTokenRequest`, `PushData`; `AccountExport.sessions[].push`; `ErasureSummary.pushTokens`.
- The parameter `push` (`expo`) in both environments' configuration (`infra/envs/*/main.tf`), so staging, its previews and production send; `PUSH` defaults to `log` in development and test and `off` elsewhere.
- Specs: `features/notifications/push.feature` (the notifications slice is not a rules slice, but who may be told of a message is the chat's rule, so its scenarios are specified), and a scenario in `features/identity/erasure.feature`.
- `rules/mobile.md`'s Notifications line, ADR-032 §4, ADR-038 Open 1 and ADR-045 Open 1 are amended to point here.

## Not done, and what would make it needed

- A push for a moderator's decision (ADR-032's `moderation` kind): #312's, when its decisions exist.
- A notice in the app for a match: ADR-038 Open 1's other half.
- Retrying a push Expo refused for the moment: if pushes are seen lost (Open 4).
- Pushes kept through the quiet hours and sent at their end: if the maintainer wants them (Open 1).

## Alternatives considered

- **The token on the account, not the session.** A sign-out on one phone would have to find that phone's token by something it sends; the session is the device already (`session.platform`), and its end is the end of its pushes.
- **Deleting the token in each revoking statement.** Three statements in the identity slice today, and the next one written would forget; a trigger is the database saying it once, as 0055 already says a revoked session's sockets close.
- **The words from the phone (a data-only push the app words itself).** iOS shows nothing for a data-only push while the app is not running, and the words would still have to be the phone's language; the server has it from the registration.
- **A title as well as a line.** The phone already shows the app's name above the line; a title "Kuutti" says it twice.
- **The interval and the receipts in tables.** One box (TD-3); what a restart forgets is a push sent early or a dead token kept until its next refusal.
- **Asking at the first conversation**, as the 17/10 plan had it for the message alone. With the round's push in the same change the first use is the first round, and every match comes through one.

## Open, the maintainer's

1. Nothing pushed in the quiet hours is sent later; the person sees it on opening the app.
2. A push makes the phone's default sound, as the person's phone settings allow; in front, the app shows it silently.
3. While the app lock is on (ADR-045 Open 1), a push says what it says without the lock: its words name nobody and nothing, so the lock has nothing to take out.
4. No retry of a push Expo refused for a moment (a 429, a 5xx, a timeout).
5. The match push goes whether or not the person is in the app, since nothing else tells them.

## History

- 2026-10-25: written with #102, on the maintainer's answers of that day.
