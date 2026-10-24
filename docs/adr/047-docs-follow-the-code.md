# ADR-047: The drawings follow the code: what a view draws is redrawn in the change, or said still true

- Status: proposed (built as written here for `docs/architecture/`; #395's flows and #396's register join as they land; accepting it, and the lists' breadth, are the maintainer's)
- Date: 2026-10-24
- Follows: #397 (the architecture views, "They stay true"), #395 (the user flows, PR #429), #396 (the register of product decisions), ADR-002 (`check:scenarios`, a check that holds a document to the code by name), CLAUDE.md (Code: "Understand first, then write the least"; Decisions), `.claude/rules/mobile.md` (the `Unwalked:` line), the maintainer's request of 2026-10-24

## Context

Three documents draw Kuutti from three sides: `docs/architecture/` (#397, on `main` since PR #432) from the system's, `docs/flows/` (#395, PR #429) from the person's, and `docs/decisions.md` (#396) as the rules and their values. A drawing that has fallen behind the code is worse than none: a contributor or a reviewer trusts it and reads the wrong system. Most of Kuutti's changes are written by agents, fast, and an agent changes what it was asked to change.

The rule existed already, in three places: the views' README ("Keeping them true"), `.claude/rules/infra.md` and `docs/adr/README.md`. Each says that a change to what a view draws redraws it in the same pull request. But `rules/infra.md` loads only when a file under `infra/` is touched, the other two are read only by whoever opens them, and nothing reminds anyone. A change to the chat's socket in `apps/api/src/chat/ws.ts` loads no rule that names `sequence-chat.md`.

#395 left out, on purpose, a check that a diagram matches the code: nothing can hold a drawing to the code cheaply. That still stands. What can be checked cheaply is the step before: that a change to what a drawing draws was looked at by its author, and that the drawing was either redrawn or said to be still true.

## Decision

1. **A drawing names what it draws.** A document that draws the code carries a block under its title, invisible on GitHub:

   ```
   <!-- draws
   apps/api/src/chat/ws.ts
   infra/modules/media/
   -->
   ```

   One path per line, from the repository's root; a trailing `/` stands for a folder and everything in it. The block holds the files whose change would change the drawing: the entry points, the protocol, the pipeline, the modules, the workflows. It is not the whole of the file's "Where it lives", which stays as it is for its readers. A test file never counts, since it checks what is drawn and draws nothing itself.
2. **Every view of `docs/architecture/` has one**, its README aside. `docs/flows/` (#395) and `docs/decisions.md` (#396) join in the change that lands them or soon after: each file gets its block, and the folder goes into `REQUIRED_DIRS` of the check. The register's own completeness check (`check:decisions`, #396, every `matching_config` key with a row) is a different question and stays its own.
3. **A change to a drawn file redraws the drawing, or says it is still true.** A pull request that touches a file named in a block either touches that document too (the diagram redrawn and its steps rewritten) or carries this line in one of its commit messages:

   ```
   Still-true: docs/architecture/sequence-chat.md (the send's limiter only)
   ```

   It says the author looked and nothing the document draws has changed. The reason in the brackets is for the reader and is not checked. Several documents may share a line, separated by commas. It is the `Unwalked:` line's kind: a statement in the history, where `git log --grep Still-true` finds it.
4. **`pnpm check:docs`** (`scripts/check-docs.ts`, no dependencies) fails in three cases: a required document without a block; a path in a block that is not in the repository, since a rename or a removal changes what is drawn and the block goes with the drawing; and a drawn file the change touches while its document is neither touched nor named on a `Still-true:` line. The change is everything since `--base` (by default where HEAD left `origin/main`), the working tree included, so an agent can run it before it commits.
5. **In CI, in the `scenarios` job,** which is already required, so the ruleset stays as it is. The job fetches the whole history, and on a pull request it compares against `HEAD^1`, the merge commit's first parent, which is the base as merged. On `main` it checks the blocks only, since the pull request was checked before the squash. Dependabot is exempt, as it is from `issue-link`: it cannot write the line, and its pins and versions change nothing a view draws.
6. **CLAUDE.md carries the rule**, since it loads in every session, unlike `rules/infra.md`, and the pull request template carries its line. The views' README, `rules/infra.md` and `docs/adr/README.md` point here instead of each restating the rule.

## Consequences

- **What it costs.** Measured on `main`'s own history with the lists as written: of the 189 commits since 2026-10-01, 84 touched a drawn file; of the 83 since 2026-10-15, 42. Most of them changed what a view draws: the photo check's steps, the bank login, the previews, the Telia kit's move to npm, the night's new jobs. October built most of what is drawn, so the rate should fall as the system settles. Each pull request that asks costs either a redraw or one line.
- **What it catches and what it cannot.** It catches a drawing nobody looked at, and a block left naming a file that has moved. It cannot see a redraw that is wrong, or a `Still-true:` line written without looking. Review sees both, and the `security-reviewer` agent reads the deployment and trust views (#397).
- **A list too broad shows up in the history** as `Still-true:` lines that keep naming the same document for the same file. That file then leaves the list, in a change that says so. A list too narrow shows up as a drawing found stale, and the file that moved it joins the list.
- **A new view is a new block**, or `check:docs` fails on the folder's rule.

## Open, the maintainer's

- **Accepting it, and the lists' breadth.** The lists are drawn from each view's "Where it lives". A few files that change for other reasons were left out: the catalog in `pnpm-workspace.yaml`, the contracts' field lists in `packages/schema`, the identity table's columns (which `check:schema-words` holds), and the logger. A narrower cut would ask less often and miss more.
- **#429's flows.** Whether they join before #429 merges (each flow's block, `docs/flows` in `REQUIRED_DIRS`) or in a change of their own after it.

## Not done, and what would make it needed

- **A Claude Code hook at the time of the edit**, one that names the drawing when an agent writes a drawn file. CI and `pnpm check:docs` say it at the commit, which is soon enough while a pull request is one sitting's work. It becomes worth doing if agents keep opening pull requests that fail here.
- **The line in the pull request's body**, where `issue-link` reads its `Refs`. The workflow reads the body from the event that started the run, which a re-run does not refresh, so a corrected body would need a new push. A line in a commit travels with the change and can be checked before the push.
- **A check of the drawing's content**, and generated diagrams: left out by #395 and #397, for the reasons they give.

## Alternatives considered

- **The rule alone, in CLAUDE.md**, with nothing that checks it. That is what `rules/infra.md` has been since PR #432: true, and read only when a path loads it.
- **A list of every file in "Where it lives".** Every file of a slice would ask: the chat's repository code and its screens, the panel's features. The line would become a reflex and say nothing.
- **A central map** in one file instead of a block in each drawing. The block sits where the drawing is redrawn, so whoever redraws a view sees its list, and the next folder needs no edit elsewhere to join.

## History

- 2026-10-24: written, with the blocks of the nine views and the check in CI.
