# ADR-028: The version bump is one command, counted from main

- Status: accepted (the maintainer's request of 2026-10-17; a required CI check stays out, §6, and adding one is his)
- Date: 2026-10-17
- Follows: CLAUDE.md "Git" (versioning: the counted version in the root `package.json`, the three apps' the same, MINOR for a feature and PATCH for fixes in the pull request that carries them), ADR-003 (the OpenAPI document and its generated types, held to the code by `schema-drift`); issue #172

## Context

Since #172 (10/10/2026) the version is counted. It lives in the root `package.json`, and the three apps' `package.json` carry the same number (`pnpm check:version`, in CI's `schema-drift`). A pull request that carries a feature bumps MINOR, and one that carries only fixes bumps PATCH, in that pull request. `apps/api/openapi.json` carries the number too, in `info.version`, which `pnpm openapi` writes from the API's `package.json`; `schema-drift` fails when the committed document differs from what `pnpm openapi` writes.

The bump was made by hand, and it failed in three ways:

- **Forgotten:** the pull request went up without a bump.
- **Half done:** the four `package.json` files were bumped, but `pnpm openapi` was not run, so `schema-drift` failed.
- **Stale after a rebase:** two branches bumped from the same main to the same number (both 0.33.6). The first merged, and the second was rebased onto it. Both sides made the same change, so the rebase merged it without a conflict, and the branch was left with main's own number and no bump of its own.

Each failure cost another push and a full CI run, about 15 to 20 minutes, and a preview build again, before the pull request could merge.

## Decision

1. **The bump is one command, counted from main.** `pnpm version:bump patch|minor` (`scripts/bump-version.ts`) runs `git fetch origin main` and reads the root `package.json` on `origin/main`: the version the pull request merges into, not the working tree's. PATCH adds one; MINOR adds one and resets PATCH. The command writes the number into the root's and the three apps' `package.json`, changing the `version` line and no other byte. It then runs `pnpm openapi`, which writes the number into `apps/api/openapi.json`, and ends with `node scripts/check-version.ts`. Because it counts from main, it is idempotent: a second run leaves the same five files. A run after a rebase onto a bumped main gives main's next number, never main's own. When the fetch fails, the command says so and counts from the `origin/main` the clone already has.
2. **What it refuses.** It refuses `major` while MAJOR is 0, since the version stays `0.y.z` until the first public release (#172), and that release's tag sets its number by hand. It refuses any other level. It also refuses to run while one of the files it writes has an unresolved merge conflict. A conflict in a `package.json` already stops `pnpm` itself, before the script starts.
3. **The check covers the five files.** `pnpm check:version` also fails when `info.version` in `apps/api/openapi.json` differs from the root's version. `pnpm openapi` writes the API package's version there unchanged, without the commit suffix the running API adds (`0.1.0-37a837c`), so the two are compared exactly. With `--staged`, the check reads the files from the index instead of the working tree.
4. **The pre-commit hook refuses half a bump.** When one of the five files is staged, `.githooks/pre-commit` runs `node scripts/check-version.ts --staged`. A commit that carries the root's new number without the apps' or the document's is refused, with a message that names `pnpm version:bump`. The hook skips this step when node is missing, and it costs nothing when none of the five files is staged.
5. **The pre-push hook refuses a branch without its bump.** For each pushed branch other than `main`, `.githooks/pre-push` compares the root `package.json` with `origin/main`'s, as the clone last fetched it (`node scripts/bump-version.ts --check-ahead <commit>`; the hook does not fetch). It refuses the push unless the branch's version is higher: "pnpm version:bump patch (or minor) — main is at X, this branch says Y". Tags, deletions and `main` pass. `git push --no-verify` skips the check for a push that has to go out as it is.
6. **No required CI check.** Dependabot's pull requests change dependencies and never bump. A required check that wanted a bump would fail every one of them until somebody pushed a bump onto the bot's branch. CI keeps `check:version` in `schema-drift`, which a Dependabot pull request passes since its five files still agree, and it runs the script's `--self-test` there. If a CI check of the bump itself is ever wanted, it would be a job that fetches the base branch, runs `--check-ahead` against `origin/${{ github.base_ref }}`, and is skipped for `dependabot[bot]`. Making it required changes the ruleset, which is the maintainer's to change. Such a job also sees main only as it was when the job ran: a pull request that went green before another bump merged stays green, unless the ruleset also requires the branch to be up to date before it merges.

## Consequences

- A bump is one command and five files in the diff. `packages/schema/src/api.generated.ts` does not carry the version, so the bump leaves it unchanged.
- The next `pnpm` command after a bump reinstalls from the lockfile, in about a second: pnpm notices that the workspace's versions changed, as it did after a bump by hand.
- A branch pushed for its preview before its work is done needs its bump first, or `--no-verify`. The bump can come first and be run again later at no cost.
- A stacked branch passes the pre-push hook once the branch below it carries a bump. `pnpm version:bump` counts from main, so after the lower branch merges, the upper branch takes its own number at the rebase the stack needs anyway.
- The hooks run only where `core.hooksPath` is `.githooks` (`pnpm env:doctor` says whether it is). A clone without them relies on review.
- The pre-push hook reads `origin/main` as the clone last fetched it, so a bump that reached main after that fetch goes unseen until the next fetch. `pnpm version:bump` fetches before it counts.
- What none of this catches: a pull request merged without a new push after another bump reached main. The squash merge takes the identical version change without a conflict, and main keeps one number for two merges. Before merging, `git fetch origin && node scripts/bump-version.ts --check-ahead origin/<branch>` tells whether the branch is still ahead.

## Alternatives considered

- **Counting from the working tree:** a second run would add one to a number already bumped, and a run after a rebase would not see main's.
- **`npm version` in each workspace:** it counts from the working tree, commits and tags by default, and knows nothing of `openapi.json`.
- **Changesets or release-please:** a tool and a workflow for a number that each pull request counts on its own.
- **A bump at merge, by a bot on `main`:** CLAUDE.md puts the bump in the pull request, never in a separate commit on `main`, and a bot's push to `main` needs a token past the ruleset.
- **A required CI check:** §6.

## History

- 2026-10-17: written at the maintainer's request, with the command, the check of `openapi.json`, the two hooks, and the script's self-test in `schema-drift`.
