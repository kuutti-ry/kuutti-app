# Phase 2: process diet

Checks and hooks that cost every pull request and catch little. This phase must land before phases 3 to 8, or every refactor pull request conflicts with every other.

Most items need the maintainer's decision (D1 to D4 in `README.md`). Line numbers here are reported by the audit; read before cutting.

## Steps

### [ ] 2.1 Bump the version at the release tag only (D1, ADR-028)

- **Today:** every pull request bumps the version in the root `package.json`, three app `package.json` files and `openapi.json`. All of the last 200 commits touch `package.json`. Any two open pull requests conflict on those lines. CI does not even enforce the bump, and `/health` already names the commit.
- **Change:** the release tag sets the version. Between releases the API reports `<last version>-<commit>`, as it does now.
- **Delete:** `scripts/bump-version.ts` (538 lines), the pre-push version block in `.githooks/`, `scripts/check-version.ts` if one file holds the version afterwards.
- **Keep:** `apps/mobile/app.json`'s store version, unchanged.
- **Check:** two branches opened from the same commit merge one after the other with no conflict.
- **Frees:** about 600 lines.

### [ ] 2.2 Reduce the docs check to "named paths exist" (D2, ADR-047)

- **Today:** a change to any file a drawing names must redraw the drawing or carry a `Still-true:` line. 41 of the last 200 commits carry one. `SettingsScreen.tsx` is named by 8 drawings. The script itself says it cannot tell whether a drawing is right.
- **Change:** `scripts/check-docs.ts` only fails when a `<!-- draws` block names a file that no longer exists. Drawings are updated when someone changes what they draw, by judgement.
- **Frees:** about 230 lines, and one line of ceremony from one commit in five.

### [ ] 2.3 Generate the ADR index (no decision needed)

- **Today:** `docs/adr/README.md` is edited by hand in 102 of the last 200 commits, and `scripts/check-adr-index.ts` (561 lines) checks it.
- **Change:** a script of about 40 lines writes the table from each record's own header (number, title, status, date). CI fails on drift, as for `pnpm openapi`.
- **Lost:** the hand-kept table from TD numbers to records. It points at a private log; keep it only if the maintainer uses it.
- **Frees:** about 520 lines.

### [ ] 2.4 Cut `skill-gates.ts` to the edit gate (D3)

- **Today:** `.claude/hooks/skill-gates.ts` is 690 lines (277 code, 413 self-test). It runs on every shell call, every edit and every turn end. It passes as soon as a skill was called once in the session, so it checks ceremony, not work. Subagents are exempt and shell writes bypass it. At every turn end it calls `gh pr view` for each unchecked pull request.
- **Change:** keep one gate of about 80 lines: an edit under the schema or the matching paths asks for the matching skill first. Drop the stop gates, the Auto-fix check and `after-merge.sh`.
- **Keep:** `session-handoff.sh` and the skills themselves.
- **Frees:** about 600 lines.

### [ ] 2.5 Take the website check off pull requests (no decision needed)

- **Today:** the required `i18n` job runs `pnpm check:legal-versions`, which fetches `https://kuutti.app/legal/versions.json`. A site outage, or the site publishing first, turns every open pull request red.
- **Change:** run it on `main` and on a schedule.

### [ ] 2.6 Drop the duplicate test run (ruleset change is the maintainer's)

- **Today:** `ci.yml` runs the API and package Vitest suites in `test-api-packages` and again, with coverage, in `compose`.
- **Change:** delete `test-api-packages`. The required-checks list goes from fourteen to thirteen.

### [ ] 2.7 Lower the coverage floors and stop counting tooling (D4, ADR-021)

- **Today:** API 95/99/99/99 including `scripts/**`; phone app 96/99/99/99; schema 99 on all four; notices 100; i18n 96/99/99/99 including scripts. Floors this high make people write a test for every defensive branch, and make deleting code a fight with the number.
- **Change:** 85 for branches and 90 for the rest in app code. `identity` keeps a stricter floor. `scripts/**`, seed and demo code are not counted.
- **Then:** phase 4 removes the tests the old floors forced.

### [ ] 2.8 Decide what the Gherkin files are for (D4)

- **Today:** `features/**` holds 711 scenarios in 4,865 lines. Nothing executes them. `scripts/check-scenarios.ts` only checks that some test has the same name as each scenario.
- **Options:** (a) keep them as the readable spec for identity, matching and erasure only, where a wrong rule hurts people, and delete the rest; (b) delete them all and let test names be the spec.
- **Recommendation:** (a). Phase 4 does the work.

### [ ] 2.9 Smaller items

- `scripts/check-fonts.ts` runs from four places (lint, two git hooks, `secret-scan.yml`). Two are enough: the pre-commit hook and CI.
- `scripts/check-licenses.ts` (305 lines): try `allow-licenses` on the dependency-review action that already runs. Low confidence; read the script first.
- The issue-link job refuses "Fixes #n". Keep it if the maintainer still wants issues closed by hand; it is one rule, cheap.

## After this phase

A pull request needs: sign-off, `Refs #n`, green typecheck, lint and tests, generated files up to date. Nothing else.
