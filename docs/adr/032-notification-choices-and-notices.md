# ADR-032: Notification choices and the notices in the app

- Status: accepted 2026-10-18 (#176, built as written here on the maintainer's decisions of that day, #176's comment; the points under "Open, the maintainer's" are his to confirm or change), amended 2026-10-22 (§2 and §7: a second kind, an invitation that counted, #107, ADR-044 §9) and 2026-10-25 (§4: the push and the phone's line came with #102, ADR-055; see History)
- Date: 2026-10-18
- Follows: TD-3 (one box, push through Expo), TD-18 (notifications), TD-7 (erasure), ADR-007 §3 and §4 (export and erasure), ADR-022 §6 (Settings), ADR-024 §7 (a warning's notice is #176's), CLAUDE.md rule 6 and Product constraints (no real-time engagement push); issues #176, #102, #101, #184, #312

## Context

#176 asks for a switch per kind of notification and for notices in the app for what must reach a person even without a push. No push exists yet: #102's message push needs `expo-notifications`, a native change the maintainer put with #184's batch on 18/10/2026. A warning from a moderator exists since #307, and ADR-024 §7 left its notice in the app to #176. Without `expo-notifications` the app cannot read whether the phone lets Kuutti notify at all.

## Decision

1. **The choices.** `notification_preference(account_id, kind, enabled, updated_at)`, one row per account and kind once the person switches it, unique on the pair; `notification_kind` is `round | message | match | moderation`. No row means on: a kind the person never touched is on, and every phone of theirs and every later sender reads the same. `GET /account/notifications` answers every kind in that order with its state; `PUT /account/notifications/{kind}` with `{ enabled }` answers the same list, and writes nothing for an account erased meanwhile (404). Nothing is sent from here: #102's push reads the round, message and match switches (ADR-055), and #312 will read the decision's.
2. **The notices.** `notice(account_id, kind, sanction_id, invitation_id, created_at, read_at)`, `notice_kind` `warning` and, since #107, `invitation_counted` (§7); #312's decisions and M5's matches add their kinds when they write one. A notice holds no text of its own: the app says it from the kind and what it points at. `GET /notices` answers the newest twenty, read and unread; `POST /notices/{id}/read` marks one of the caller's read, once (the first time stands), and another's or nobody's is 404. Every statement names the caller's account (rule 6).
3. **A warning tells the person.** `applySanction` with the kind `warn` writes the notice in the sanction's transaction (ADR-024 §7), pointing at its sanction (`ON DELETE CASCADE`); a check holds a warning to its sanction. The notice reads the sanction's reason, which the app words as the export does, and a warning lifted since is not shown. A shadow ban, a suspension and a ban write none: a shadow ban tells nobody anything (ADR-024 §7), and the other two end the sessions and are said at the bank login.
4. **What is not here, and why.** No push, and no line saying whether the phone allows notifications or a way to its settings: both needed `expo-notifications` and came with #102 (ADR-055, amended 2026-10-25), which reads the round, message and match switches; the moderation switch waits for #312. Until then the Settings screen said plainly that nothing was sent to the phone. No list of past notices beyond the twenty, no count on a badge, no feed (Product constraints): the home screen shows the unread ones, each with Got it, and the export holds them all.
5. **Erasure and export** (ADR-007 §3, §4). Erasure deletes the person's choices and notices, before the sanctions their notices point at. The export carries every kind with its state and every notice with when it was read.
6. **The app.** Settings › Account › Notifications: the opening line, then one switch per kind with its line, saved at once, the switch waiting while it is on its way and a failure said in words. The home screen: the unread notices first, under "Notices", nothing at all without one.
7. **A counted invitation tells its inviter** (#107, ADR-044 §9). The night an invitation counts, its inviter gets a notice of the kind `invitation_counted` that points at the invitation (`notice.invitation_id`, migration 0079, `ON DELETE CASCADE`; a check holds that kind, and it alone, to an invitation, as one holds a warning to its sanction). The app says that an invitation of theirs counted and what it earned, counted from the invitation's own units, never who was invited. `Notice` is a union by kind: a warning carries its `reason`, a counted invitation its `reward`. §3's filter that hides a lifted warning applies to warnings alone. The notice goes with its invitation, and with the account at erasure (§5).

## Consequences

- Migration 0062 (`notification_preference`, `notice`, the enums `notification_kind` and `notice_kind`), generated.
- Routes `GET /account/notifications`, `PUT /account/notifications/{kind}`, `GET /notices`, `POST /notices/{id}/read`, behind the session guard; the contracts of `packages/schema/src/notifications.ts`; `AccountExport.notifications`; `ErasureSummary` gains `notificationChoices` and `notices`.
- `applySanction` writes a warning's notice. The demo's removal of identities deletes both tables' rows.
- Specs: a scenario in `features/safety/sanctions.feature` and one in `features/identity/erasure.feature`; the notifications slice has ordinary tests (`features/README.md`).

## Alternatives considered

- **A row per kind for everybody, written at registration.** A default on the row rather than in the read would need a migration to add a kind; "no row means on" lets a kind be added in the enum alone.
- **The choices on the phone.** Every sender is the server's (#102), and a person with two phones would have two answers.
- **A notice with its own text.** A moderator's words are staff's and stay out of the person's view (ADR-024 §8); the app's words in three languages say the same to everybody.
- **The permission line now with `Linking.openSettings` and no state.** It would send people to a setting that changes nothing until #102; the maintainer chose to wait (18/10/2026).

## Open, the maintainer's

1. Every kind is on until switched off (§1); the alternative is off until switched on, for the kinds that push.
2. The moderation switch governs a push only: a warning is always a notice in the app (§3).
3. The twenty newest notices, read ones included, kept until the erasure; the alternative is a prune of read notices after some months.

## History

- 2026-10-18: written with #176: the choices, the notices, a warning's notice, erasure and the export; the permission line left to #102.
- 2026-10-22 (#107, ADR-044 §9): a second kind of notice, `invitation_counted`, written by the night's count of invitations: §2 names it and §7 says how it is written and read; `Notice` became a union by kind.
- 2026-10-25 (#102, ADR-055): the push exists: the round, message and match switches are read by its senders, and Settings › Notifications says whether the phone lets Kuutti notify, with the way to the phone's settings, or the phone's own question while it was never asked (§4 amended). The opening line no longer says that nothing is sent.
