---
name: personal-data
description: Walk a change that adds or moves a person's data through erasure, export, scoping, retention, logs, research events and the privacy notice. Use before any new table or column, any change to `packages/db/src/schema`, and any new place a person's data is kept or sent. A hook refuses edits to the schema until this skill has run in the session.
argument-hint: [what is being added]
---

Kuutti is a dating app run by a registered association: erasure and export are legal duties, and what fails here fails in silence. `apps/api/src/identity/personal-data.test.ts` is the register of every table, and CLAUDE.md's non-negotiable rules outrank anything below. Read `docs/security-checklist.md` first. A change that does not touch a person's data ends at step 1: say so in one line.

## 1. Name the data

What is it, whose, and why does the feature need it? The least that works: can it be computed, coarser, or not kept at all? Never a column for the hetu, legal sex, a full date of birth, the name from the bank, or message text or email in `events` (`pnpm check:schema-words`).

## 2. Erasure

Decide for each new table and each new column, and write it into the register:

- **It goes** with the person: the row is removed by a call in `eraseAccount` (`apps/api/src/identity/erasure.ts`).
- **It stays**, the person cut from it: the reason names the ADR, and each column that outlives the person is listed. A new column on a row that stays is the easy one to miss; a new column on `account` belongs in `tombstoneAccount` unless there is a reason it does not.
- **It names nobody:** only with no foreign key to `account` or `identity`, and no way back to a person.

Then add the eraser's line to the erasure list in `.claude/rules/db.md`, and its test in `erasure.test.ts`. The erasure runs in one transaction, and order matters there: read its comments. An object in the bucket goes through `deleteOrphanedObjects`.

## 3. Export

The export is everything Kuutti holds about the person (`exportAccount`, `AccountExport` in `packages/schema/src/account.ts`). Add the data to a section, in plain words in the request's language where a value would otherwise mean nothing. Never the other person: no name, no id, no code. A table left out needs its reason in the register. Run `pnpm openapi` if the contract changed.

## 4. Scope

Every query is scoped by the session's `account_id` in the query itself (rule 6). Show it with a wrong-user test on each new route. A hard filter holds in both directions (rule 7).

## 5. Retention

How long does it stay, and what removes it? A nightly job needs a test and a row in `docs/decisions.md`. Retention is the maintainer's call and a change to it needs an ADR: ask, never settle it.

## 6. Where it travels

- **Logs, errors, Sentry:** never the hetu, message text, email, `seeks`, a contact's value, a token or a client address. The structured log carries `account_id` and the request id. A test fails on a PII pattern in the output.
- **Research events:** keyed by `research_id`, never `account_id`, and never message text (rule 5), through the registry in `packages/schema`. A new event or property goes through `change-rule` too.
- **Push and mail:** one line of the app's words; no name, no text, no id.
- **Outside services and LLMs:** never a person's data.
- **Photos:** only through the API's pipeline (rule 4).

## 7. What people are told

If the data is new to the person, the privacy notice on kuutti.app may need a change, and a consent may need a new version (`CONSENT_VERSIONS`, `pnpm check:legal-versions`; the site lives in `kuutti-ry/kuutti-app-site`). A sensitive answer needs its special-category consent. Legal wording is the maintainer's: name what changes and ask.

## 8. Report

In the pull request: what is held, its fate at erasure, its section in the export, its retention, and what the maintainer decided. An ADR is required for a change to data retention, identity, uploads or event flow.
