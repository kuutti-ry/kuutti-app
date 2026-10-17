-- Custom SQL migration file, put your code below! --
-- blocked_between(a, b) (#84, ADR-030 §2): whether a block stands between the
-- identities of two accounts, in either direction. A block is kept between
-- identities so that it holds for a later account of either (block, migration
-- 0050). Every read that shows one person to another asks it with the
-- viewer's account id and the subject's (findCardSubject in profile/repo.ts,
-- findVisiblePhoto, recordCardServed and insertPhotoAccess in media/repo.ts;
-- the rounds, likes and matches when they land), so the clause is written
-- once and no other slice reads the safety slice's table. Symmetric by
-- construction. STABLE and read-only: two lookups on the pair index per call.
-- A SQL-standard body (BEGIN ATOMIC) rather than a string: Postgres parses it
-- here and records what it reads, so a later migration cannot drop or retype
-- block or account's columns under it without saying so. A function is
-- nothing drizzle-kit derives from the schema, hence this custom migration
-- (rule 10). OR REPLACE: a local test database that applied an earlier
-- draft of this migration, with the string body, takes this one instead of
-- failing on a function that exists; a fresh database is the same either way.
CREATE OR REPLACE FUNCTION blocked_between(a uuid, b uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE
BEGIN ATOMIC
  SELECT EXISTS (
    SELECT 1 FROM account x, account y, block bl
    WHERE x.id = a AND y.id = b
      AND ((bl.blocker_identity_id = x.identity_id AND bl.blocked_identity_id = y.identity_id)
        OR (bl.blocker_identity_id = y.identity_id AND bl.blocked_identity_id = x.identity_id)));
END;
