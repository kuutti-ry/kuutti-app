---
paths:
  - "apps/**"
  - "packages/**"
  - "features/**"
---

# Code layout: vertical slices and the import boundary

Code is organised by feature slice, not by layer. There is no `controllers/`, `services/` or `repositories/`. A change to one rule touches one directory per app, CODEOWNERS on a slice is a real security boundary, and an agent loads one directory instead of a mental map. Decision: ADR-002 and issue #1.

## Slices

| slice | api | mobile | admin | primary TDs |
|---|---|---|---|---|
| identity | heavy | thin | auth only | TD-1, TD-7 |
| profile | medium | heavy | read | TD-16 |
| media | heavy | medium | queue | TD-2, TD-8 |
| pond | medium | thin | read | TD-10, TD-13 |
| matching | heavy | heavy | none | TD-11, TD-12, TD-14 |
| chat | heavy | heavy | snapshots | TD-3 |
| safety | medium | thin | heavy | TD-5, TD-6 |
| research | medium | none | read | TD-5 |
| rewards | light | light | none | TD-15 |
| notifications | light | light | none | TD-3, TD-18 |

Not every slice appears in every app, and the asymmetry is informative: a slice heavy in two apps and absent from the third is where the integration risk is.

## A feature is a name, not a directory

The same name appears in the same form wherever the feature has a part:

```
features/matching/*.feature             spec (Gherkin, rules layer only)
packages/schema/src/matching.ts         zod contracts, the only shared code
packages/db/src/schema/matching.ts      tables
apps/api/src/matching/                  the work: routes.ts, rounds.ts, filters.ts, index.ts, *.test.ts
apps/mobile/src/features/matching/      components, hooks, queries
apps/admin/src/features/matching/       only if moderation touches it
```

The seam between apps is shared vocabulary and one shared contract, never shared code. Do not create a top-level directory holding mobile and server code together; it breaks Metro and Vite and buys nothing.

## Inside each app

```
apps/api/src/
  <slice>/      routes.ts  service.ts  repo.ts  index.ts  *.test.ts
  lib/          db.ts  config.ts  logger.ts  s3.ts  ssm.ts  auth-middleware.ts
  jobs/         the nightly runner and its jobs (waitlist snapshot, pond gate, the slices' sweeps)
  app.ts

apps/mobile/
  app/                      Expo Router routes only, thin, delegate to features
  src/features/<slice>/     components, hooks, queries, index.ts
  src/lib/                  api client, secure storage, theme
  src/components/ui/        React Native Reusables primitives
```

## Import boundary

- A slice may import from `packages/schema`, `packages/db`, and its app's `src/lib/`.
- A slice may not reach into another slice's internals. Anything a neighbour needs is exported from the neighbour's `index.ts`, which is its public surface, or it moves down into `lib/`.
- Two slices that keep needing each other mean the boundary is in the wrong place, not that the rule is wrong. Raise it; do not work around it.
- What stays horizontal: `lib/` in each app, `components/ui/` on the clients, and `packages/*`. The test is whether every slice uses it and none owns it. Do not force real infrastructure into a slice for symmetry.
- The boundary is enforced by Biome (`noRestrictedImports` in `biome.json`, part of `pnpm lint`; #2).

## Specs and tests

- Rules-layer slices (`identity`, `matching`, `media`'s photo check, `pond`, `safety`, `chat`, erasure, and `notifications`' whom a push tells, ADR-055) have `features/<slice>/*.feature`. The rest have ordinary tests.
- Scenario name = test name, verbatim. `Scenario Outline` = `describe(<name>)` around `it.each(rows)`. `@pending` for spec-before-code.
- `pnpm check:scenarios` runs in CI. Renaming a scenario without renaming its test fails the build; that is the point.
