# ADR-040: "Löysin hänet": telling Kuutti you found someone

- Status: accepted 2026-10-21 (#83, built as written here on the maintainer's decisions of that day; the points under "Open, the maintainer's" are his to confirm or change)
- Date: 2026-10-21
- Follows: TD-5 (research needs its own yes, the events never carry text), TD-7 (erasure), ADR-007 (erasure and export), ADR-011 (the research events), ADR-022 (taking a break), CLAUDE.md rule 5 and rule 10; issue #83

## Context

The association has one measure of success: people who find someone. #83 asked for a way to tell Kuutti so, and ADR-022 expected it to be a second way into the break, the same state with a reason. On 21/10/2026 the maintainer decided otherwise: it is an indication and nothing more, and nothing in the app changes ("sometimes the other counterpart might not even find their 'hänet'"). His answers of that day: three reasons from a closed list; each person's own answer counts, with no confirmation by anybody else; the other person sees no change; the measure is an anonymous count by day, shown in the moderation panel, with a research event for those who said yes to research; each account answers once; no bank login before it.

## Decision

1. **An indication only.** Telling Kuutti changes no state, no visibility, no session, no round, no conversation, and nothing another person reads. Stepping away is the break (ADR-022) or the deletion (ADR-007), and the screen says where they are.
2. **Three reasons, closed.** `here` (on Kuutti), `elsewhere`, `other` (`FoundReason`, `packages/schema/src/found-them.ts`), as radio buttons in words. "Another reason" never asks for words: there is no text to store, read or moderate.
3. **The count names nobody.** `found_them_count` (migration 0073, generated) holds a count per Finnish day and reason, and nothing else. `POST /account/found-them` adds one to the day's row in the transaction that records the answer (`tellFoundThem`, `apps/api/src/identity/found-them.ts`). The row is not personal data, so it outlives every erasure, and the measure counts those who later left.
4. **Once per account, never the reason.** `account.found_them_answered` (in 0073) is all the account keeps: the reason is in the count and, with research consent, in the event, never on the account. The answer takes the account row's lock first, so two devices answering at once count once; a second answer is 409 `found_them_answered`, said in the request's language, and counts nothing. `GET /account/found-them` tells the screen whether to ask or to thank. Erasure clears the flag with the tombstone; the export carries it (`foundThemAnswered`, ADR-007). A person who erases and registers again is a new account and may answer again.
5. **The research event.** `found_them` carries the reason alone (ADR-011): keyed by `research_id`, sent only for those whose research consent is live, as every event.
6. **The panel.** The overview (`GET /admin/overview`) shows the counts by reason for the last thirty Finnish days and in all, never a day's row, never a person.
7. **Where it is.** "I found someone" on Your account, before the break (`/settings/found-them`). Any account the guard admits may answer, before onboarding too, and no fresh bank login is asked: the answer changes nothing and is worth nothing to anyone who took a phone.

## Consequences

- The measure is a count of claims. Nobody confirms them, and one of a pair may say so while the other does not; the maintainer chose that.
- An answer cannot be taken back or changed. A wrong reason stays counted; the count is too coarse for one answer to matter.
- What stays possible, in the logs: the request log line names the account and the route, never the body. On a day with one answer, somebody reading both that line and the day's row learns that account's reason, for as long as the log group keeps the line (thirty days, ADR-007's History of 2026-10-13). A count by week would blur it; the maintainer's to choose (below).
- What stays possible, in the database (the security review of 21/10/2026): the flag and the count are written in one transaction, so the account row and the count row it last moved carry the same transaction id (`xmin`), and somebody who can read both tables (the API's role, a restored snapshot) can join them and learn the reason of the last person counted in each day and reason; with five thousand people most rows count one, so that is most answers. It lasts until the account row is written again (a break, the e-mail, a sanction, the erasure's tombstone) or the count row is (the next answer of that day and reason). Writing them in two transactions would not help: at this traffic consecutive ids link them as well, and a count by week does not either. Rewriting the closed days' count rows at night would not end it alone: the account row keeps its answer's id, which dates the answer, and on a day whose answers share one reason the day's counts then tell it. A nightly run that rewrites both, the closed days' count rows and every answered account's row (`UPDATE account SET found_them_answered = found_them_answered WHERE found_them_answered`, all of them, or the night's id would date them in turn), would end it for every day but the current one, older row versions until the vacuum and snapshots taken before; the maintainer's to choose (below). For those in the study the reason is linked to their pseudonym by design (§5).
- The Maestro flow `found-them` runs as Aino before her account deletion, which erases her answer (ADR-014 §4 needs no new persona: the flow changes nothing any other flow reads).

## Alternatives considered

- **A pause with a reason** (ADR-022's expectation, #83's first shape): the maintainer chose an indication only.
- **Both of a pair confirming:** the other person may not have found anyone, and the measure would ask one person about another.
- **The reason on the account:** it would go with the erasure, and the measure with it, and the account would keep what it does not need.
- **A research event only:** only those who said yes to research would count.
- **Free words for another reason:** text to store, moderate and keep out of every event and log, for a measure that needs none.

## Open, the maintainer's

1. The words in the three languages ("I found someone", "Löysin hänet", "Jag hittade någon"), with the native review.
2. The panel's thirty days (`FOUND_THEM_RECENT_DAYS`, `apps/api/src/safety/overview-routes.ts`).
3. A count by week instead of by day, should the log's residual of the Consequences matter.
4. The nightly rewrite of the closed days' count rows and the answered accounts' rows, should the database's residual of the Consequences matter.

## History

- 2026-10-21: written with #83's build, on the maintainer's decisions of that day.
