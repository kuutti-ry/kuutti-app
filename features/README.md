# Feature specifications

Gherkin specifications for the rules layer only: `identity`, `matching`, `media` (the photo check), `pond`, `safety`, `chat` (who may write to whom, ADR-031), `notifications` (who is told of what by a push, and when not, ADR-055), and erasure. Everything else has ordinary tests. Why and how: `docs/adr/002-gherkin-spec-vitest-runner.md`.

- One directory per slice, one file per topic, scenario names unique across the tree.
- A `Scenario` is a Vitest `it()` with the same name, verbatim. A `Scenario Outline` is a `describe()` with the outline's name wrapping an `it.each` over the `Examples` rows.
- Tests live with the slice (`apps/api/src/<slice>/*.test.ts`), not here.
- `@pending` marks a scenario whose slice does not exist yet. The pull request that implements it removes the tag.
- `pnpm check:scenarios` fails when a non-pending scenario has no test with its name, or when two scenarios share a name.
- If a `Given` needs more than three lines of setup, it is not a Gherkin scenario. Write an ordinary test.
