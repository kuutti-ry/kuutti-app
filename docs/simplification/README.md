# Simplification roadmap

Written 2026-11-10 from a whole-repo audit. Nothing here is done yet. Each phase file is a work list: what to change, where, how to check it, and how many lines it should free.

## Goal

Simple, working, readable code that a person can run and understand. Same behaviour for members and moderators. Much less code.

## Where we start, where we want to land

| | Today | Target |
|---|---|---|
| Source (non-test TypeScript, generated files excluded) | about 92,000 lines in 622 files | about 60,000 |
| of which comments | about 16,300 (18%) | about 6,000 |
| of which tooling (seed, demo, notices, i18n scripts, root scripts, hooks) | about 21,000 | about 9,000 |
| Tests | about 156,000 lines | about 80,000 |
| Agent rules (`CLAUDE.md`, `.claude/rules/`) | about 16,000 words | about 4,000 |

The targets are estimates from measurements, not promises. Phases 6 and 7 start with a pilot that measures the real saving before the rollout.

## Out of scope

The stack. The slice boundaries. The client-server contract types. The database schema and migrations. Every ADR's product decision. Anything a member or moderator can see.

Where one of these is the real cause of bloat, the phase file says so under "Needs the maintainer" and the work waits.

## Phases, in order

| # | File | What | Frees (source / tests) | Blocked by |
|---|---|---|---|---|
| 0 | `00-bugs.md` | Seven real bugs and risks, small fixes | about +100 | nothing |
| 1 | `01-rules-and-docs.md` | New `CLAUDE.md` with the keep-it-small rules, short rules files, README for people, glossary | 12,000 words | maintainer reads the draft |
| 2 | `02-process-diet.md` | Version bump, docs check, ADR index, hooks, CI, coverage floors | 1,900 / 0 | decisions D1–D4 |
| 3 | `03-delete-tooling.md` | Delete or shrink tools bigger than their job | 12,000 / 12,000 | D5 for one item |
| 4 | `04-tests.md` | One test level per rule, drop restated tests | 0 / 60,000 | D4 |
| 5 | `05-comments-and-names.md` | One "why" sentence per comment, plain names | 10,000 / 0 | phase 1 |
| 6 | `06-api.md` | Route helper, typed queries, less wiring, one copy of each rule | 5,000 / follows | D6, pilot first |
| 7 | `07-mobile.md` | One read hook, one send helper, screens rebuilt on them | 2,500 / follows | pilot first |
| 8 | `08-admin-and-packages.md` | Shared panel pieces, contracts package cleanup | 1,500 / follows | nothing |

Why this order:

- Phase 0 is small and real. It does not wait for anything.
- Phase 1 comes early because every later change is written by agents that read those rules. Fix the rules first or the bloat grows back while we cut it.
- Phase 2 must come before 3 to 8. Today every pull request bumps the version in five files and answers the docs check, so two open refactor pull requests always conflict.
- Phases 3 and 4 are pure deletion. They make every later phase cheaper, because there is less to keep green.
- Phase 5 is mechanical and makes the code readable before anyone restructures it.
- Phases 6 to 8 are the real refactoring. They go last because they are the riskiest.

## Decisions the maintainer must make

| # | Decision | Touches | Blocks |
|---|---|---|---|
| D1 | Bump the version at the release tag, not in every pull request | ADR-028 | phase 2 |
| D2 | Reduce "docs follow the code" to "named paths exist" | ADR-047 | phase 2 |
| D3 | Cut `skill-gates.ts` to the edit gate | maintainer's rule of 30/10/2026 | phase 2 |
| D4 | Coverage floors to about 85–90%, tooling not counted, one test level per rule | ADR-021 | phases 2, 4 |
| D5 | Delete the libvips notices gatherer, keep its output file | #416, #421 | one item of phase 3 |
| D6 | Route descriptions in `openapi.json` may be reworded (types unchanged) | ADR-003 | part of phase 6 |
| D7 | Send push and mail after the transaction commits, not inside it | comment in `notifications/push.ts` | bug 2 |
| D8 | Simple cleanup of the sign-in table instead of eviction | ADR-026 §6 | one item of phase 6 |
| D9 | Move the queue builder from `jobs/` into `matching/` | `.claude/rules/layout.md` | one item of phase 6 |

Nothing else needs a decision. Work that does not depend on an open decision goes ahead.

## Rules for every pull request of this roadmap

1. One pull request does one thing from one phase file. Small enough to review in one sitting.
2. Phases 3 to 8 change no behaviour: no contract type, no schema, no screen, no user-facing text. A bug found on the way is its own pull request with the test that fails first.
3. `pnpm typecheck`, `pnpm lint` and `pnpm test` are green before pushing.
4. The pull request body states lines added and lines removed. A refactor that adds more than it removes says why.
5. Deleted code is deleted, not commented out and not kept "for later". Git has it.
6. Tick the item in the phase file in the same pull request.

## The real ceiling

About a third is the most the code can lose inside this scope. Past that, the code is big because the product is big for 5,000 people: 110 `matching_config` keys and 69 decision records. `09-feature-candidates.md` does not exist yet; if the maintainer wants a list of features that could be cut or deferred with the lines each would free, that is a separate piece of work.

## What the audit did not cover

- Nothing was run except `pnpm knip`. No test suite, no `pnpm env:up`.
- Not read: `infra/`, most workflows beyond `ci.yml`, most test bodies (the test numbers come from about 14 of 434 files), `apps/mobile/plugins` and theme, `pond/`, parts of `research/` and `profile/`, `lib/push.ts`, the SQL triggers.
- Four big phone screens were only skimmed: `ProfileCardView.tsx`, `PhotosScreen.tsx`, `FieldEditor.tsx`, `SettingsScreen.tsx`.
- Items marked "reported" in the phase files came from the audit's reading and were not re-checked. Read the code before acting on them.
