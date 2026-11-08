---
paths:
  - "docs/**"
  - "CLAUDE.md"
  - "CONTRIBUTING.md"
  - ".claude/rules/**"
  - "apps/*/README.md"
  - "packages/*/README.md"
  - "services/*/README.md"
  - "infra/README.md"
---

# Decision records and the TD numbers

The reasoning behind Kuutti's rules lives in two places. The technical decisions log, TD-1 to TD-19, is in the maintainers' private planning documents, which the repository cannot show; where a record and the log disagree, the log wins. The architecture decision records in `docs/adr/` are public. `docs/adr/README.md` is the bridge between them (#203): every record with its status, its date and the TD numbers it cites, and every TD number with the records and the docs that cite it, so that a reader of a TD number in CLAUDE.md finds what to read. `pnpm check:adr-index` (CI's `scenarios` job) holds that page to the records and to the docs; this rule says what the check cannot.

## A record

- A record is due when a change touches identity, upload, event flow, data retention or infrastructure (CLAUDE.md, Decisions; the `change-rule` skill asks for it in the same pull request as the rule's row). It is `docs/adr/NNN-title.md` under the next free number, and opens with `- Status:`, `- Date:` (when it was written) and `- Follows:` (what it rests on: TD numbers, other records, CLAUDE.md's rules, issues), before the Context, the Decision in numbered points, the Consequences, what is open and whose it is, the alternatives and a History.
- A TD the decision rests on, departs from or amends is cited by number, `TD-n`, in `Follows` or in the text, so that the TD's row leads to the record. The log's text is never quoted or paraphrased as the log's: say in the record's own words what the citation means. A TD number is never renumbered, and a TD a record departs from is still cited ("departed from here, see Context").
- The same pull request adds the record's row to the first table of `docs/adr/README.md` (its status word for word, its date, the TD numbers it cites or `none`, a note in one sentence) and the record to the Records cell of every TD it cites.

## A change to a decision

- A later change is made in the record itself, as a numbered amendment or a History line, and its status line says so: `amended <date> (§n: what, #issue; see History)`. A new record that changes another says "amends ADR-NNN" and the other's status line names it back. A History line that only records how the decision was carried out (a cut-over, a check that now runs) changes no point and leaves the status line as it is.
- The statuses are the README's: proposed, accepted, amended, superseded. Accepting is the maintainer's. The agent writes a record as `proposed`, with a parenthesis saying how far it is built and what waits on him, and turns it `accepted` only on his word in chat, naming the day and where he gave it; "do the issue", a pass over the lines or a tidy-up is not that word (#203, 2026-11-08). A superseded record is kept for its reasoning.
- A changed status line is copied into the record's row in the same pull request; the check refuses a row that differs by a character.

## A TD cited in a doc

- CLAUDE.md, CONTRIBUTING.md, these rules, `docs/` and the README at the root of an app, a package, a service or `infra/` cite a TD by number where a rule or a step follows from it. A new citation joins the TD's last cell in the README's second table, by the file's path or its basename, a README with its folder, with a few words on what the file says; a citation removed leaves the cell. A slice's README, a workflow or a flow may cite a TD without a place in the cell, and may have one where no record decides the TD.
- "TD-1 to TD-19" names the log, not a decision; a narrower range cites every number in it.

## After the edit

`pnpm check:adr-index` after any of the above; `pnpm check:docs` says which drawings the change touches (ADR-047); `pnpm check:decisions` holds `docs/decisions.md` to `matching_config` (#396). The `open-pr` skill runs them before the pull request.
