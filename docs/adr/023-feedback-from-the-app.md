# ADR-023: Feedback from the app

- Status: accepted
- Date: 2026-10-15
- Follows: TD-5 (research events never carry text), TD-7 and ADR-007 (the erasure table and the export), ADR-006 (the audit log), ADR-011 (the event registry), TD-18 (no mail without a reason), CLAUDE.md rules 5 and 6, `.claude/rules/db.md`, `.claude/rules/admin.md`; issue #171

## Context

The demo and the first users will find what the checklist did not, and the only channels today, GitHub and the association's address, are not in a person's hand inside the app. #171 asks for a way to send a bug, an idea, a complaint or praise in a few lines, which the moderators read in their panel with the app's version and platform, and nobody mailed. Four kinds keep the queue sortable. The issue left one thing open: whether a person's feedback outlives their account.

## Decision

1. **The contract** (`packages/schema/src/feedback.ts`): `FeedbackKind` is `bug`, `idea`, `complaint`, `praise`; the request is the kind, the text trimmed and bounded to 2000 characters, the app's counted version, the platform (`ios`, `android`, `web`) and the language the app showed, a BCP 47 tag. No attachments. The app reads the three facts about itself; a person types the kind's choice and the words, nothing else.
2. **One table, one tunable** (`feedback`, migration 0041; `matching_config feedback_per_day` = 5, migration 0042): the account, the kind, the text, the version, the platform, the locale, when it was sent, and when and by whom (an identity) it was handled. At most `feedback_per_day` rows per account and Finnish calendar day, counted in the statement that writes the row under an advisory lock per account, the export's shape (ADR-007 §3); the next one is refused with 429 `feedback_budget_exceeded` and `Retry-After` until midnight, said in words on the screen. The number is a row, never a constant.
3. **The route and what it never does** (`POST /feedback`, the safety slice, behind the session guard): it stores the row and logs the kind, the build and the account id, never the words (rule 5, `rules/api.md`); the PII log test covers the route like every other. One research event, `feedback_sent { kind }`, joins the registry (ADR-011 §2): the kind alone, recorded only with the research consent, which `track()` checks.
4. **Erasure and export.** The rows go with the account, in `eraseAccount`'s transaction, and the export lists them with the kind, the build and whether a moderator read them (ADR-007 §4). The issue offered keeping the rows without the account id instead; rejected: the text is free text a person wrote, which can name them or anybody, and a moderator who has not read it by then has lost nothing the person did not take back on purpose. The one line to change is the delete. No retention clock of their own: a handled row stays as long as the account, which is the moderators' own history of what was said.
5. **The app.** A row under Account in Settings, "Give feedback", and a screen of its own: the four kinds as a radio group whose chosen option is ticked in words (never a colour alone), a multiline field, Send, disabled until a kind is chosen and something is written; thanks afterwards, with "Send more" for the empty form; the day's cap and a failure in their own words, the words kept. Signed out, the screen says there is no session.
6. **The panel.** The unhandled rows, a bug first and praise last, the oldest first within a kind (`GET /admin/feedback`, moderators and admins), each with its kind, words, build and the sender's account id, and "Mark as handled" (`POST /admin/feedback/{id}/handled`), once: the `audit_log` row `feedback.handle` with the kind and the mark are one transaction, keyed on the unhandled state, so of two moderators exactly one writes. No reply channel until mail exists (TD-18).

## Consequences

- Migrations 0041 (the table, two enums, two indexes) and 0042 (the tunable); the seed carries the same row and `migrate.test.ts` holds the two identical.
- `AccountExport` gains `feedback`; `ErasureSummary` counts it.
- `AUDIT_ACTIONS` gains `feedback.handle` and `AuditEntry.subjectType` admits `feedback`.
- The panel renders the list under the photo queue, English only (TD-17); the app's texts are in three languages, the Finnish and Swedish machine-flagged for the native review.
- Specs: `features/safety/feedback.feature` and one scenario in `features/identity/erasure.feature`; the Maestro flow `give-feedback` walks the screen as Sanna.
- Open, the maintainer's: a kind the moderators find missing, a cap other than five, and whether a handled row should expire.

## Alternatives considered

- **A `feedback` slice of its own.** The panel's reading, the audit row and the moderators' queue are the safety slice's, and a slice per screen is the layering the layout rule refuses; the module sits beside the photo check's notes.
- **Keeping the rows anonymised after erasure.** Rejected above (§4).
- **Mailing the moderators or the sender.** No mail until a reason exists (TD-18); the panel is the channel.
