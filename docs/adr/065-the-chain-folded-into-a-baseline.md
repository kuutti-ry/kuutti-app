# ADR-065: The migration chain folded into one baseline

- Status: accepted 2026-11-05 (#611, the maintainer's decision of that day; how staging crosses is his, §5)
- Date: 2026-11-05
- Follows: CLAUDE.md rule 10, `.claude/rules/db.md`. Makes one exception, once, to rule 10's "never edited afterwards" and to db.md's "a version of a key that lives is never deleted or rewritten" (ADR-013 §17, ADR-060 §6).

## Context

By 05/11/2026 the chain was 110 migrations and 9.5 MB of snapshots, each new one adding about 140 KB, and `migrate.test.ts` was about 1,300 lines of tests of how data nobody has was moved in October. No real person's row existed anywhere: staging holds Telia's test persons and the synthetic population (ADR-018), and production did not exist (#25). So the chain protected no data, and the moment to fold it closes for good when the first real row lands. The maintainer asked for it on that day. What he asked to keep is the way future changes are made.

## Decision

1. **The mechanism stays.** The schema is TypeScript, `generate` and `generate --custom` write the next numbered file, nothing generated is edited afterwards, and the entrypoint applies what is pending under the advisory lock. The next migration is 0002.

2. **Two files stand for the chain.** `0000_baseline.sql` is `generate` from `src/schema` alone. `0001_baseline_sql.sql` is `generate --custom` with what the DSL cannot say (the immutability triggers, the partitioned `events`, `blocked_between`, the chat's notifications, the push token's trigger), each in its last form, then the one pond and every key that lived.

3. **Every key is version 1 at the value it stood at**, written by `migration:0001`. The seed's `MATCHING_CONFIG_V1` carries the same rows, and `_V2` and `_V3` go with the versions they mirrored. A new key is still born in a migration and in `MATCHING_CONFIG_V1`. A migration that writes a key's next version brings `MATCHING_CONFIG_V2` back. Who decided each value stays in `docs/decisions.md`, which is why a key's earlier versions could go.

4. **It was proved against the chain, once**, at commit 77768edf. `pg_dump --schema-only` of an empty database taken through the 110 migrations and of one taken through the two files differ only in the order of columns inside `CREATE TABLE`: the enums and their label order, the 154 constraints, the 112 indexes, the 13 triggers and the 11 function bodies are the same text. Nothing reads a column by position. The 83 keys hold the same values and the pond the same row. A later generate on top of the baseline writes one `ALTER TABLE`, and a next-version data migration applies to both a fresh database and a stamped one.

5. **A database that carries the old journal refuses the baseline.** The migrator takes the baseline as pending, its first `CREATE TYPE` fails with 42710, the transaction rolls back and the boot stops, with everything as it was (`migrate.test.ts`). It cannot be damaged by forgetting. There are two ways across:

   - **Made anew:** an empty database, then the boot's migrations. On a deployed one the audit boundary and the demo come again (`infra/README.md`).
   - **Stamped:** where the database has run the chain to its end and never a branch's migration, its schema is the baseline's, so the journal's rows are replaced by the two the migrator would have written, and nothing else is touched:

   ```sql
   BEGIN;
   DO $$ BEGIN
     IF (SELECT (count(*), max(created_at), sum(created_at)) FROM drizzle.__drizzle_migrations)
        IS DISTINCT FROM (110::bigint, 1793827411048::bigint, 197137026651472::numeric) THEN
       RAISE EXCEPTION 'this database has not run main''s chain to 0109_pond_counter_finished';
     END IF;
   END $$;
   DELETE FROM drizzle.__drizzle_migrations;
   INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES
     ('ac38e0e69fd5b0f485cfe61fb17515b98d51080edbb3ff9a7a4a2b90fc2cb715', 1793903336035),
     ('96b5e859f6c260cad2594681d75f96a357d4d4c293a54676a9f3f91cd148abb9', 1793903336596);
   COMMIT;
   ```

   The guard reads the journal's count, its last entry and the sum of its timestamps together, so it stamps only a journal that is main's chain to its end: an empty one, one short of the end, one with a branch's migration added or in place of one of main's, and one already stamped are refused and left as they were. The two rows are the files' SHA-256 and their `when` in the journal, written out because the migrator compares only `created_at`, and a larger number would skip every later migration without a word.

   A stamped database keeps its people and its earlier config versions, which change nothing, since the latest version of a key wins and a migration writes the next one as `max(version) + 1`.

6. **Never again once a real person's row exists anywhere.** From then on the chain is what moved real data, and a test of a move is a test of what happened to somebody.

7. **The old numbers are history.** "Migration 0055" in an earlier ADR, in the register's Recorded in column or in a commit means the chain as it stood at 77768edf, and `git show 77768edf:packages/db/drizzle/0055_chat_notify.sql` reads it. Text that says where something lives today names the object or `0001_baseline_sql.sql`.

8. **The tests follow.** `migrate.test.ts` keeps the lock's race, the config against the seed and the second run, and what the database itself refuses, each named for its rule rather than its migration (a sanction's parts, an invitation's, a session's family hash, the second pass's mark, the counter's default). The tests of data moves go. The partial-chain helper went with them: a future data migration's test takes it from git history, where it is `migrationsBefore`.

## Left out on purpose

- **`drizzle-kit push` instead of migrations.** It cannot say the triggers, the functions, the partitioned table or the config rows, so a hand-run SQL step would come straight back unreviewed; a non-interactive push is destructive on a rename; and the first real users would need migrations again at the worst moment.
- **Pruning only the snapshots.** `drizzle-kit check` holds the folder consistent, and a half-pruned folder is hand-editing.
- **Keeping config versions across the fold.** The register carries the decisions, and a version 1 that held a value nobody uses would be kept for no reader.
