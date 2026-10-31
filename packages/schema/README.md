# @kuutti/schema

Single source of contracts: route inputs and outputs as zod schemas, and the research event registry. zod is the only dependency because React Native imports this package. Rules: `.claude/rules/schema.md`.

`src/postal-areas.generated.ts` is Statistics Finland's data under CC BY 4.0, not under the repository's licence: `pnpm places` writes it, and `src/postal-areas.NOTICE.md` beside it says what it is and what Kuutti changed (ADR-061 §4). It is read through the subpath `@kuutti/schema/postal-areas`, never the package root.
