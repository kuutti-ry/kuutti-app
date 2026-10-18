# notifications

Daily round push, in-conversation push, optional email channel. TD-3, TD-18.

- `NotificationChoices.tsx` (#176, ADR-032): Settings › Notifications, one switch per kind (a new round, messages, matches, moderators' decisions), stored on the server and on until switched off, with a line saying that nothing is sent to the phone yet; the phone's own permission comes with #102's native update. The settings slice wraps it in its page.
- `Notices.tsx` (#176): the home screen's notices, the unread ones under a heading, each with Got it, which marks it read; nothing when there are none. Today a moderator's warning with its reason (ADR-024 §7).
- `client.ts`: `GET /account/notifications`, `PUT /account/notifications/{kind}`, `GET /notices`, `POST /notices/{id}/read`.
