# ADR-021: Tests at every level, measured by branches and errors

- Status: accepted (the maintainer's decision of 2026-10-11)
- Date: 2026-10-11
- Follows: TD-2 (test runners), ADR-002 (Gherkin for the rules layer), ADR-003 (types across the client-server boundary), ADR-017 (the Telia kit's conformance table), ADR-020 (end-to-end flows); issue #235
- Supersedes: CLAUDE.md's "No global coverage number" and the coverage thresholds named for `packages/core`, a package that never existed

## Context

On 2026-10-11 the API's tests ran 95 % of the lines they loaded and 83 % of the branches; counting every file, 83 % and 71 %. Most routes had one or two tests, not the four cases CLAUDE.md asks of each. Identity, the one path with a coverage threshold in CLAUDE.md, had no threshold configured and no coverage provider installed. Several components of the app and the admin panel had no test of their own, and nothing measured the four packages (the Telia kit at 83 % of branches, `i18n` at 65 %). Lines run are not decisions checked: a refusal nobody triggers, an error nobody raises and a filter nobody crosses pass a line-coverage report.

The tests written for #235 also found what reading had not: a login race that answers 500, a moderator sent to the app's deep link, a log line that redacts its own message, a deadlock between two research tests, and code nothing called.

## Decision

1. **Every behaviour is tested at the lowest level that can show it, and again where it composes.** The levels:
   - *unit*: a function, a module, a component on its own;
   - *integration*: a route through `app.request()` on the real database (never a mocked one), a repository on the real database, the S3 stand-in, a component with its hooks against the client boundary;
   - *contract*: the client-server boundary (the OpenAPI document and the generated types, ADR-003) and every vendor boundary, both directions: what we send is what the vendor documents, what we accept is what the vendor provides, and the in-repo double is held to the same contract so it cannot drift. Fixtures are built in the vendor's documented shape; a check against the vendor's live public metadata may exist, opt-in and outside the default run;
   - *property-based* (fast-check, seeded) for parsers, validators and rules over a domain: the hetu, the filters, the gate;
   - *rules specifications* (Gherkin, ADR-002) for the rules layer;
   - *end-to-end* (Maestro, ADR-020) for what a person does.

   A package that could leave the repository (`packages/tunnistus-oidc`, ADR-017) carries every level that applies to it inside itself: our implementation, and its contract with Telia.
2. **Inputs vary.** Each input is tested by its equivalence classes and their boundaries (the minimum, the maximum, one past each), empty, missing and null, the wrong type, too long, unknown keys under `.strict()`, text outside ASCII, and each of the three locales where text is the output. Where the input space is a domain, a property-based test covers it.
3. **Branches and errors, not lines.** Every reachable branch has a test that takes it and asserts what it does (the status and body, the rows, the log line, the rendered role and label), never one that only runs it. Every error the code raises, maps or catches has a test, including what is rolled back and what is not logged. In identity and the hard filters, each condition of a compound decision is shown to decide the outcome on its own. Every route is tested for its happy path, each validation rule that gives a distinct answer, the unauthenticated variants the code tells apart (no token, malformed, unknown, ended, expired), the wrong user, and each of its own error branches. Code that handles a concurrent writer is tested by deterministic interleaving (the helper of `apps/api/src/identity/races.test.ts`), not by sleeping.
4. **Measured on every pull request, with a floor per package.** `pnpm test:coverage` runs in CI: the API and the packages in the compose job, where Postgres, the S3 stand-in and the mock bank are up; the app in `test-mobile`. Each package has a floor set just below what it reaches when the floor is set, and identity a stricter one. Branches are the first number read. A floor goes up when the code allows; a pull request that lowers one says why.
5. **What the measure leaves out, and why.** Processes of their own, which coverage of the test workers cannot see, are tested by spawning them: the demo commands, `scripts/openapi.ts`, the server's process shell `apps/api/src/index.ts` (its boot is `boot.ts`, tested in-process). Generated files are left out. Placeholder slices have nothing to test.
6. **Where it makes sense.** No test for a re-export, a constant or a type. No contortion for a branch that cannot run: a test that needs a mock of the impossible proves the mock.
7. **Code nothing uses is removed; so is logic that cannot run.** Before removing, indirect use is ruled out: the name in strings anywhere in the repository (YAML, JSON, workflows, Maestro flows, docs), namespace imports, routes called from outside the repository (the bank's redirect, health checks, the demo commands), files loaded by convention (Expo Router's `app/`, `.native.ts` and the other platform files, tool configuration, `tsup` entries, `package.json` scripts and `exports`). An unreachable branch is kept when it is (a) narrowing TypeScript's strict mode requires (`rowCount ?? 0`, a check after an indexed access), (b) defence in depth on a rule of CLAUDE.md, or the bound that keeps a retry loop finite, (c) a fail-fast guard against a misbuilt artefact or configuration, or (d) a re-check under a lock against a concurrent writer; the kept ones are listed (#235) so nobody chases them.
8. **A bug a test finds is not fixed in passing.** It is recorded with a reproduction and fixed in a change of its own, with the test that failed first.

## Consequences

- `@vitest/coverage-v8` (catalog, beside `vitest`) and `pnpm test:coverage` in the root, the three apps and the four packages; Jest counts every source file of the app, the ones no test loads too.
- The floors live in each package's `vitest.config.ts` and in `apps/mobile/jest.config.js`; CLAUDE.md's Testing section says where.
- More tests, longer runs: the API's suite took 27 s with 523 tests and about 30 s with 889. The compose job runs the packages twice (plainly in `test-api-packages`, with coverage in `compose`) so that neither required check changes its name.
- Not adopted now: mutation testing (Stryker), which measures whether assertions would notice a changed line. It is the next step if coverage stays high while bugs keep slipping past weak assertions. Snapshot tests do not stand in for assertions.
