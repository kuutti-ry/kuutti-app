---
paths:
  - "packages/db/**"
---

# Database (Drizzle + RDS PostgreSQL) rules

Consult `https://orm.drizzle.team/llms.txt` for API specifics.

- The schema is TypeScript in this package. Migrations come from `drizzle-kit generate`, are committed as SQL, reviewed as SQL, and never hand-edited. One migration per change. What the schema DSL cannot express (a trigger, a function, a versioned data row) goes through `drizzle-kit generate --custom --name <what>`: the tool creates the numbered file and the journal entry, the SQL inside is written for it, cited in an ADR, and reviewed like any other; a generated file is never edited afterwards. The API entrypoint applies them under an advisory lock; a manual RDS snapshot precedes a release-tag migration.
- Naming: snake_case tables and columns, `timestamptz` for every timestamp with an `_at` suffix, uuid primary keys unless there is a stated reason.
- `identity` and `account` are separate tables from the first migration. Standing and bans live on `identity`. `ponds` has `parent_id` from the first migration.
- Never add a column for: hetu, legal sex, full date of birth, name from the bank, message text in `events`, email in `events`.
- `preferences(account_id, field, value, mode hard|soft, include_unknown)`; deal-breakers are `mode = hard` rows. The round builder joins both parties' hard rows.
- `events` is append-only with monthly partitions and 90-day retention, keyed by `research_id`, never `account_id`.
- `matching_config` is versioned. Parameters are rows, never constants in code.
- Erasure per TD-7: deletion removes profile, photos, preferences, the place at the pond gate, the optional e-mail, likes, matches, bookmarks, push tokens, sessions, and the `research_id` mapping row; it keeps the identity row, the counterpart's message copies, report snapshots for 12 months, and audit log entries for 5 years.
- Indexes: 7-day exposure count per candidate, `last_active_at`, and the eligible-pool lookup. Add the index in the same migration as the query that needs it.
- The seed creates a few hundred fake verified users with valid-format hetus. Previews and local dev are always seeded, never a copy of production.
- RDS specifics: one connection pool, no RDS Proxy. LISTEN/NOTIFY and advisory locks are fine on the ordinary connection. Do not propose a pooler.
