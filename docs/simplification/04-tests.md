# Phase 4: tests

Tests are about 156,000 lines against 92,000 of source, two to three times the source in every slice. The goal is not fewer tests. It is that every test left fails when real behaviour breaks, and that changing code does not mean rewriting three times as much test code.

Needs decision D4 (coverage floors and test levels, ADR-021). Do phase 2.7 first.

The audit sampled about 14 of 434 test files. Treat the shares below as a guide, and read each file before deleting from it.

## The rule from now on

One test per rule, at the lowest level that can catch the bug:

| What | Where it is tested | Not also |
|---|---|---|
| A zod schema's shape | Nowhere on its own. The route test that sends a bad body covers it. | A schema test restating its own bounds |
| A route's behaviour | `app.request()` against real Postgres | A unit test of the function the route calls, saying the same |
| A pure rule (filters, ordering, hetu parsing) | A unit or property test | A route test for every input class again |
| A screen | One component test per state a person can see | A test per internal function of its hook |
| A race | A deterministic interleaving test | |
| A script | Only where a mistake costs data | |

## Steps

### [ ] 4.1 Delete tests of deleted tooling

They go with phase 3: libvips (1,627), the HTTP history writer (about 500), self-tests (about 2,500), batch translate and review modes (about 1,000), the cast (about 300).

### [ ] 4.2 Delete tests that restate constants and schema bounds

- **Where:** `packages/schema/src/*.test.ts` (about 6,200 lines). Example: `account.test.ts:28-31` is `expect(EMAIL_MAX).toBe(254)`.
- **Also:** 39 constant assertions elsewhere, such as `apps/api/src/lib/ssm.test.ts:10`, `apps/api/src/app.test.ts:326`, `apps/api/src/research/partitions.test.ts:38`.
- **Keep in `packages/schema`:** tests of real logic (the profile-field rules, banding functions, the research event registry's "no message text" guard).
- **Keep:** `apps/mobile/src/expo-image.test.ts` and `react-native-screens.test.ts`. They pin patched dependency source and are justified by the patches.
- **Frees:** about 4,000 lines.

### [ ] 4.3 Collapse the same rule tested at several levels

- **Example:** the six-digit e-mail code is tested in `packages/schema/src/account.test.ts:78`, `apps/api/src/identity/email-confirmation.test.ts:413` and `:683`, and `apps/mobile/src/features/identity/EmailCard.test.tsx:448`.
- **How:** slice by slice. For each rule, keep the test at the level in the table above and delete the others.
- **Order (largest first):** safety (12,953), identity API (12,052), profile on the phone (12,203), identity on the phone (9,468), matching (7,943), chat on the phone (7,054), chat API (6,611), media (6,194), jobs (5,263), lib (5,260).

### [ ] 4.4 Shrink the largest screen tests

- **Example:** `apps/mobile/src/features/matching/RoundScreen.test.tsx` is 3,482 lines and 156 tests for a 522-line screen.
- **How:** one test per state a person can see (loading, a card, no cards, a match, each refusal) and one per accessibility rule. Logic inside `useRound` is tested once, in the hook's test.
- **Do after phase 7** for screens that phase rebuilds, so the tests are written once.

### [ ] 4.5 Gherkin (see 2.8)

- Keep `features/identity`, `features/matching` and the erasure scenarios. Delete the rest and their one-to-one tests where a route test already covers the rule.
- `scripts/check-scenarios.ts` stays for what remains.

### [ ] 4.6 Tests to keep whole

These catch real bugs and are worth their size:

- `apps/api/src/test/pii-in-logs.test.ts`: drives every route with personal data and checks no log line carries it.
- `apps/api/src/identity/personal-data.test.ts`: the erasure and export register.
- `apps/api/src/identity/races.test.ts`, `matching/matches.test.ts` ("the same moment"): the concurrency tests.
- `apps/api/src/safety/no-signal.test.ts`: who may read a report's copy.
- The hetu and HMAC property tests.

Not opened by the audit, purpose unjudged: `safety/sanctions.test.ts` (1,692), `media/moderation.test.ts` (1,627), `jobs/short-pool.test.ts` (1,473). Read before touching.

### [ ] 4.7 Add the tests that are missing

The audit found risky logic with no test. Each comes with its bug fix in phase 0:

- A slow push or mail must not hold the pool (B3, B4).
- The photo retry reaches everything in one night (B6).
- The seed and the moderator CLI refuse a managed database (B1, B2).
- The chat screen on an empty conversation (B8) and a failed send (B9).
- A callback without an exchange leaves a break in place (B10).
- `apps/api/scripts/demo-*.ts` is excluded from coverage: the unscoped `DELETE FROM pond_counter` in `demo-reset.ts:122` has no test.

## Check

Mutation-style spot check after each slice: break one rule on purpose (flip a comparison, remove a guard) and confirm a test fails. If none does, a needed test was deleted; restore it.

## Target

About 156,000 to about 80,000 lines. Roughly: tooling tests 15,000, schema restatements 4,000, level collapse 35,000 to 45,000, screen tests 10,000.
