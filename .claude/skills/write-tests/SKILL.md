---
name: write-tests
description: Bring the tests of a change to Kuutti's standard (ADR-021) at every level that applies: add what is missing, change what the behaviour moved, remove what no longer earns its place, and show that the tests can fail. Use whenever a change adds or alters behaviour, whenever the user asks for tests, and before open-pr; a hook refuses `gh pr create` on a branch that changes code until this skill has run in the session.
argument-hint: [path or slice]
---

ADR-021 and CLAUDE.md's Testing section are the rule; this is how a change meets it. The goal is not more tests. It is that a broken behaviour turns something red, at the lowest level that can show it, and again where it composes. Work from the diff (`git diff origin/main...HEAD`, the working tree too), or from the argument when there is one.

## 1. List the behaviours, not the files

For each change, write down what a caller or a person can now observe: the answers, the rows, the log line, the role and label on the screen, each refusal and each error. A rename with no new behaviour may need nothing but the tests' own names.

## 2. Read the tests that exist

Read the tests around the changed code before writing one: what they assert, which helpers they use, and what they already cover. Search by behaviour too; a route's rule may be held in another slice's test or in `features/`.

Then sort them:

- **Change** a test whose behaviour moved on purpose, and say so. Never loosen an assertion to get green: a test that fails for a reason nobody intended has found a bug, and that goes in a change of its own with the test that failed first (ADR-021 §8).
- **Remove** a test of code that is gone, one that repeats another at the same level, one that asserts nothing but that the code ran, and one that holds a constant, a type or a re-export. Rule out indirect use before removing code (ADR-021 §7). A renamed or removed `Scenario` takes its test with it.
- **Keep** the rest untouched.

## 3. Choose the levels

Every row that applies, and only those:

| what changed | level | where |
|---|---|---|
| a function, a module, a component | unit | beside the file, `*.test.ts(x)`: Vitest for `apps/api` and `packages/*`, jest-expo for `apps/mobile` |
| a route | integration | `app.request()` on real Postgres, a transaction rolled back per test: the happy path, each validation rule with a distinct answer, each unauthenticated variant the code tells apart, the wrong user, each error branch |
| a repository, a query, a migration | integration | real Postgres, never a mocked database; a scoped query is shown not to reach another account |
| a concurrent writer | integration | deterministic interleaving (`apps/api/src/identity/races.test.ts`'s helper), never sleeping |
| the client-server boundary | contract | `packages/schema`, `pnpm openapi`, and a test on the side that reads the new field |
| a vendor boundary | contract | both directions: what we send is what the vendor documents, what we accept is what the vendor provides, and the in-repo double is held to the same contract |
| a parser, a validator, a rule over a domain | property-based | fast-check with a seed |
| the rules layer (identity, matching, pond, safety, chat, erasure, media's photo check, whom a push tells) | rules specification | `features/<slice>/*.feature`, the `Scenario` name verbatim as the `it()`; more than three lines of `Given` means an ordinary test instead |
| what a person does | end-to-end | a Maestro flow in `apps/mobile/e2e/flows` with its texts in all three languages and a persona of its own where it changes something (its README's table); Playwright in `apps/admin/e2e` for the panel |
| a screen | component and accessibility | the role, the label, the 44 pt target; the screen-reader walk is separate (`.claude/rules/mobile.md`) |
| logs, where they carry anything new | unit or integration | a test fails on a PII pattern in the output |

A level left out needs a reason, and the pull request says it. No test for a re-export, a constant or a type, and no contortion for a branch that cannot run.

## 4. Vary the input

For each input: its equivalence classes and their boundaries (the minimum, the maximum, one past each), empty, missing and null, the wrong type, too long, unknown keys under `.strict()`, text outside ASCII, and each of the three locales where text is the output. Every reachable branch has a test that takes it. Every error the code raises, maps or catches has one, including what is rolled back and what is not logged. In identity and the hard filters, each condition of a compound decision is shown to decide the outcome on its own.

## 5. Show that each test can fail

This step makes the tests meaningful, and it is the one most easily skipped.

- A test asserts the outcome: the status and body, the rows, the log line, the rendered role and label. A mock's call count alone, a snapshot, or a `toBeDefined` does not show the behaviour.
- For every test that guards a rule, a refusal or an error branch, break the code it guards (flip the condition, drop the check, return early), run the test, see it fail for the expected reason, and put the code back. Check with `git diff` that nothing of the break remains. A test that stays green has found nothing: fix it or remove it.
- A new test also has to pass for the right reason: no real network, no wall clock, no unseeded randomness, no order dependence on another test.

## 6. Run them

- The touched package first, then `pnpm test`. The API's Vitest runs from `apps/api`, never with `--root`, and needs Postgres (`DATABASE_URL`, or the local default in CLAUDE.md). Run one pnpm command at a time; two at once collide.
- `pnpm test:coverage` for a package with new branches, and read branches first. A floor goes up when the code allows; a pull request that lowers one says why. The API's run needs the S3 stand-in and the mock bank, as in CI's compose job.
- `pnpm check:scenarios` after any change to a `.feature` or a test's name.
- Only the touched Maestro and Playwright flows locally. CI runs the rest (a pull request labelled `e2e`, and `main`).

## 7. Report

Say which behaviours gained, changed or lost tests at which levels, what was removed and why, what was shown to fail, and which levels were left out and why. That goes into the pull request body. A flake met on the way is fixed in the same pull request, with a comment on why.
