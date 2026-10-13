# @kuutti/db

Drizzle ORM schema in `src/schema`, migrations generated into `drizzle/` by drizzle-kit and committed as SQL, a migrate runner the API entrypoint calls under an advisory lock, the seed, and the demo tools (`@kuutti/db/demo`, for command lines and tests only). The hetu format itself is `@kuutti/tunnistus-oidc/hetu`. Rules: `.claude/rules/db.md`.

- `pnpm --filter @kuutti/db generate --name <what>` after changing `src/schema`; commit the SQL and `drizzle/meta`. Never edit a generated file. CI regenerates and fails on a diff.
- `pnpm --filter @kuutti/db migrate` applies committed migrations (the API does this at boot).
- `pnpm --filter @kuutti/db seed -- --env development` upserts the pond tree and `matching_config` version 1; refuses `production`.
- `pnpm --filter @kuutti/db test` needs Postgres and CREATEDB on the test role: end-to-end tests run in a temporary database that is dropped afterwards.

Conventions: snake_case tables and columns, `timestamptz` with an `_at` suffix, uuid primary keys, `identity` and `account` separate from their first migration, no column for hetu, legal sex, full date of birth, or name (enforced by `scripts/check-schema-words.ts`).
