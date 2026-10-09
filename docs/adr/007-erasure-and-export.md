# ADR-007: Account erasure and data export in M3

- Status: accepted
- Date: 2026-09-26
- Follows: TD-7 (erasure and re-registration), TD-1 (identity apart from account), `.claude/rules/db.md` (the erasure table), issue #34 (the identity half), issue #51

## Context

The erasure table of TD-7 says what deletion removes (profile, photos, preferences, likes, matches, bookmarks, push tokens, sessions, the `research_id` mapping) and what it keeps (the identity row, the counterpart's message copies, report snapshots for twelve months, audit log entries for five years). #34 wrote the identity half: one more deletion on the identity, a thirty-day cooldown, the account row anonymised. Most of the table's rows do not exist yet in M3; what does is sessions, login attempts, photos with their review rows, the fetch log and the account's age. The right of access needs an export of the same data. This ADR fixes how those two work now, so the slices that follow join a shape rather than invent one.

## Decision

1. **Erasure is one transaction for the rows, then the objects.** `POST /account/delete` with `{ "confirm": true }` (the app asks first; a stray call without the body does nothing). In one transaction: every session and login attempt of the account is deleted; every photo row (and, by cascade, its review row) and every fetch log entry of the account is deleted; the account row is kept as a tombstone with `state = 'deleted'`, `deleted_at`, and `birth_year` and `birth_month` set to null (the two columns became nullable for this); the identity row gets `deletion_count + 1` and `reregister_after` thirty days out. After the commit the photo objects whose content key no remaining row references are deleted from the bucket, best effort and logged: an object store has no rollback, so rows first and objects second, never the other way round. The audit log, `moderator_roles` and `admin_session` are not touched: they belong to staff identities and to history, not to the account.
2. **Why a tombstone and not a deleted row.** The identity keeps counting and cooling down without it, but the account id is what the fetch log of other people (M4), the audit log and the report snapshots will name; a row that exists with nothing personal on it keeps those references meaningful and lets "one live account per identity" stay a database constraint. What is personal on the row, the age, goes.
3. **Export is one JSON document.** `GET /account/export` answers with the account (id, state, dates, age), the identity's dates and the bank's identification level (never `hetu_hmac`: it identifies nothing without the key and nothing to the person), the devices signed in, the photos with fifteen-minute URLs for their variants and their moderation outcome (decision, reason, whether a person decided, when; never the label names, which describe the machine's guess and not the person), and the person's own fetch log, newest first, at most a thousand rows. The URLs are issued through the same path as any fetch, so the export writes to the fetch log it returns. Nothing about anyone else is in it, and a test greps for another account's id.
4. **The rest of the table joins here.** Profile fields (#46, #47), preferences, likes, matches, bookmarks, push tokens and the `research_id` mapping (#50) each add a statement to `eraseAccount` and a section to the export in the change that creates the table; the counterpart's message copies and report snapshots (M4) are the kept side. `eraseAccount` in `apps/api/src/identity/erasure.ts` is the one place. The optional e-mail of #148 (TD-18) is a column on the account: set and cleared by the person (`PUT`, `DELETE /account/email`), nulled by the tombstone with the age, carried in the export as the person's own data, and never in a log line or an event.
5. **The app.** Until the profile screens exist, the home screen's account card carries "Download my data" (the export handed to the system share sheet on the phone, a download on the web preview) and "Delete my account" behind a confirmation that names the cooldown. Deletion signs the device out locally at once; every token of the account is already gone on the server.

## Consequences

- A person who deletes and comes back after thirty days gets a fresh account with nothing restored (TD-7); the tombstone row and the identity's counter are what makes the refusal inside the cooldown possible without keeping anything else.
- The export can be large in URLs but small in bytes; a client caches nothing from it (`Cache-Control: no-store`).
- Migration 0008 relaxes two NOT NULL constraints; every live account still has both values, written by the callback.
- Deleting the objects after the commit means a crash between the two leaves unreferenced objects in the bucket. M4's report and sanction work brings the orphan sweep that covers this and the upload-crash case of ADR-005.
- Which objects are orphans is decided after the commit, against committed rows, so an upload of the same content that committed during the erasure keeps its objects. A window remains between that check and the delete; the upload's failure path and `deletePhoto` have had the same one since #57. Closing it takes a per-content-key ownership protocol (an advisory lock around put + insert and around check + delete, or the row before the objects) in the media slice as a whole, to be settled with the M4 orphan sweep.

## Alternatives considered

**Deleting the account row.** Rejected as above: references from history and from other people's logs would dangle, and the constraint on one live account per identity would lose its anchor.

**Anonymising by overwriting with placeholders.** Rejected: null says "gone" without inventing a value; the columns were made nullable instead.

**A zipped export with the image bytes.** Rejected for now: the fifteen-minute URLs give the same bytes without the API assembling archives on one box; the client can fetch them. Revisit if a store review asks for a single file.
