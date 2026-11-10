# Phase 3: delete or shrink tooling

About 21,000 of the 92,000 source lines are tools, not the product. Many are far bigger than their job. This phase is deletion; it changes nothing a member or moderator sees.

Before deleting anything, grep the whole repo for its name: `package.json` scripts, workflows, Dockerfiles, docs.

Sizes are source plus the tool's own tests.

## Delete

### [ ] 3.1 The libvips notices gatherer (D5)

- **Where:** `apps/api/scripts/notices/libvips.ts` (1,474), `notices-libvips.ts`, `libvips.test.ts` (1,627)
- **What it is:** Regenerates `apps/api/notices/libvips.json`, the licence texts of the C libraries inside sharp. Run by hand after a sharp upgrade that moves libvips. The JSON has one commit.
- **Why delete:** It reimplements a shell reader, Cargo's feature resolver, tar and SPDX parsing. The build already fails when the JSON is stale.
- **Keep:** the JSON, its README, and a paragraph on how to rebuild the file (the script is in git history).
- **Lost:** at the next libvips bump, someone recovers the script or does a few hours of hand work.
- **Frees:** about 3,190 lines and the `smol-toml` dependency.

### [ ] 3.2 `demo-stories.ts`

- **Where:** `apps/api/scripts/demo-stories.ts` (146 + about 30)
- **Why:** The stories without the erase. Nothing automated runs it; `demo-reset` does the same and more.
- **Frees:** about 180 lines and one `package.json` script.

### [ ] 3.3 Inline self-tests of scripts that are not worth a test

- **Where:** about 3,700 lines of `--self-test` code inside `scripts/*.ts`, run on every pull request.
- **Keep a self-test only where a mistake costs data:** the target guard of load-smoke, the port and process logic of `dev-env.ts`, `check-schema-words.ts`.
- **Frees:** about 2,500 lines.

## Shrink

### [ ] 3.4 `scripts/load-smoke.ts`: 2,520 to about 600

- **What it is:** A load test run by hand once per milestone.
- **Cut:** the hand-written argument parser (`:269-378`) and its 50 cases (`:1275-1404`); the WebSocket server written by hand for the self-test (`:2403-2520`); the symlink and hardlink tests of the temp-file writer (`:1662-1753`).
- **Use:** `node:util.parseArgs`, which `dev-env.ts` already uses.
- **Keep:** the guard that refuses production, the budget planning from the rate-limit headers, the table of numbers.
- **Alternative:** a k6 script of about 150 lines. It loses the budget planning and the refresh-token write-back. Only worth it if someone already knows k6.

### [ ] 3.5 `scripts/e2e.ts`: 928 to about 350

- **Cut:** the emulator-recovery path (`:283-468`, tests `:583-927`), about 580 lines for one CI flake. Re-run the failed job instead.
- **Use:** `parseArgs` for `:252-280, 475-505`.

### [ ] 3.6 `scripts/dev-env.ts`: 683 to about 400

- **Cut:** the Homebrew PostgreSQL fallback and handover (`:292-383, 636-642`). Require Docker; README already lists it.
- **This also removes** the risky `pg_ctl stop` of bug B7.

### [ ] 3.7 Demo and seed: about 6,900 to about 5,000

| Item | Where | Change | Frees |
|---|---|---|---|
| Two history writers | `apps/api/scripts/demo/histories.ts:58-176`, `demo/services.ts:49-126` | Use the direct writer everywhere; delete the HTTP one. Every end-to-end sign-in still walks the real routes. | about 220 + 500 tests |
| The cast | `packages/db/src/seed/cast.ts` (936) | 48 extra staging people, none named by a flow. Cut to about 12. Reviewers on staging see fewer cards. | about 480 |
| Demo reset | `apps/api/scripts/demo-reset.ts`, `demo/reset.ts` | Remove duplicated steps; cut the 60-line header. | about 120 |
| `writeRounds` | `packages/db/src/seed/rounds.ts:71-166` | It is `writeWaitingLikes` with one argument empty. One function. | about 50 |
| The barrel | `packages/db/src/seed/demo.ts` (111) | Import from the files directly. | about 100 |
| Argument parsers | `seed/command.ts:52-99`, `demo-reset.ts:70-96`, `demo-assets.ts:49-72` | `parseArgs`. | about 100 |
| One-pond scaffolding | `packages/db/src/seed/population.ts` | There is one pond; drop the code for several. | about 50 |

Keep the 25 personas and the mock-bank page: every one is named by an end-to-end flow.

### [ ] 3.8 i18n scripts: about 3,000 to about 2,100

- **Keep:** build, check, ICU validation, the inline-string lint. They run on every pull request.
- **`translate.ts` and its lib (921):** drop batch mode. It halves the price of a few hundred strings. About 440 lines.
- **`review.ts` and its lib (825):** drop the markdown export, `--all`, `--list` and the plain table. The reviewer's sheet (TSV export and import) and `--approve` stay. About 450 lines. Today 3 strings are reviewed and 1,241 are machine text, so this machinery has barely been used.

### [ ] 3.9 Shared helpers the scripts each rewrote

- `expect` / `same` assertions, five times: `bump-version.ts:293`, `e2e.ts:586`, `load-smoke.ts:1251`, `places.ts:346`, `skill-gates.ts:281`. Use `node:assert`.
- A `git()` helper, four times: `bump-version.ts:157`, `check-fonts.ts:91`, `check-docs.ts:232`, `skill-gates.ts:574`. Two of those files go in phase 2; the rest share one 10-line helper.
- A source-file walker, four times: `apps/api/src/test/sources.ts:22-32`, `apps/api/src/matching/no-orientation.test.ts:24-34`, `scripts/check-scenarios.ts:44-58`, `scripts/check-schema-words.ts:55`. `fs.globSync` (Node 22) does it.

## Keep as it is

- `packages/notices` and `apps/api/scripts/notices/third-party.ts`: they list what the bundle really ships, which standard licence tools do not.
- `scripts/places.ts`: yearly, reads public data, its output is reviewed as a diff.
- `scripts/fonts.ts`, `check-fonts.ts`, `check-schema-words.ts`, `check-decisions.ts`, `doctor.ts`.
- `apps/admin/e2e/run.ts` (853 lines) was not read. Read it before deciding.

## Check

After each deletion: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm knip`, and the API image still builds with its `THIRD_PARTY_NOTICES`.
