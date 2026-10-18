# notifications

Daily round push, in-conversation push, optional email channel. TD-3, TD-18.

- `notifications.ts`, `repo.ts`, `routes.ts` (#176, ADR-032): what a person may be notified of, one switch per kind (`GET /account/notifications`, `PUT /account/notifications/{kind}`), on until switched off, stored as a row only once touched; and the notices in the app (`GET /notices`, `POST /notices/{id}/read`), what must reach a person even without a push, holding no text of their own. The first notice is a moderator's warning, written in the warning's transaction (`recordWarningNotice`, ADR-024 §7); a warning lifted since is not shown. Erased with the account; in the export. Nothing is sent from here yet: #102's message push reads the message switch.
