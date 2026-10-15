import type { Queryable } from "@kuutti/db";

// The research slice's rows (#50, ADR-011): the research_id mapping, the
// snapshot read, the event insert and the export read. Every query is scoped
// by the caller's account_id (rule 6); the research_id is read here and stays
// here, never in a response and never in a log line next to the account.

export type SubjectRow = { researchId: string; consentVersion: string; enrolledAt: Date };

/**
 * The mapping row, in the consent's transaction. Only for a live account. A
 * row that already exists keeps its pseudonym and its enrolment time; only
 * the consent version moves to the wording just accepted, so later events
 * name the text the person read last (ADR-010 §4) while the events written
 * before keep the version of their day.
 */
export async function enrolSubject(
  tx: Queryable,
  accountId: string,
  consentVersion: string,
  at: Date,
): Promise<"enrolled" | "updated" | "no_account"> {
  const result = await tx.query<{ inserted: boolean }>(
    `INSERT INTO research_subject (account_id, consent_version, enrolled_at)
     SELECT $1, $2, $3
     WHERE EXISTS (SELECT 1 FROM account WHERE id = $1 AND state <> 'deleted')
     ON CONFLICT (account_id) DO UPDATE SET consent_version = EXCLUDED.consent_version
     RETURNING (xmax = 0) AS inserted`,
    [accountId, consentVersion, at],
  );
  // xmax is 0 on a row this statement inserted and non-zero on one it updated.
  const row = result.rows[0];
  if (!row) return "no_account";
  return row.inserted ? "enrolled" : "updated";
}

/** Withdrawal and erasure: the row goes, the events stay, unlinkable from here on. */
export async function removeSubject(tx: Queryable, accountId: string): Promise<number> {
  const result = await tx.query("DELETE FROM research_subject WHERE account_id = $1", [accountId]);
  return result.rowCount ?? 0;
}

export async function findSubject(db: Queryable, accountId: string): Promise<SubjectRow | null> {
  const { rows } = await db.query<{
    research_id: string;
    consent_version: string;
    enrolled_at: Date;
  }>(
    "SELECT research_id, consent_version, enrolled_at FROM research_subject WHERE account_id = $1",
    [accountId],
  );
  const row = rows[0];
  return row
    ? {
        researchId: row.research_id,
        consentVersion: row.consent_version,
        enrolledAt: row.enrolled_at,
      }
    : null;
}

export type SnapshotRows = {
  researchId: string;
  consentVersion: string;
  gender: string | null;
  birthYear: number | null;
  birthMonth: number | null;
  /** The pond's slug, or null before the person chose one. */
  pond: string | null;
  /** The stored profile document's fields, as written; the registry filter decides what enters. */
  fields: unknown;
};

/**
 * Everything a snapshot needs, in one read, and nothing when there is no
 * mapping row: no consent, no event. The mapping row is share-locked for the
 * rest of the caller's transaction, so a withdrawal or an erasure that races
 * the event waits for it and then deletes the row, and no event lands after
 * the consent ended (the events table has no foreign key to catch that).
 * `ponds` and `profile` are shared vocabulary from packages/db; they are read
 * here, read-only, so that the profile slice can emit events without the
 * research slice importing it back (rules/layout.md).
 */
export async function snapshotRows(db: Queryable, accountId: string): Promise<SnapshotRows | null> {
  const { rows } = await db.query<{
    research_id: string;
    consent_version: string;
    gender: string | null;
    birth_year: number | null;
    birth_month: number | null;
    pond: string | null;
    fields: unknown;
  }>(
    `SELECT s.research_id, s.consent_version, a.gender, a.birth_year, a.birth_month,
            p.slug AS pond, pr.fields
     FROM research_subject s
     JOIN account a ON a.id = s.account_id
     LEFT JOIN ponds p ON p.id = a.pond_id
     LEFT JOIN profile pr ON pr.account_id = a.id
     WHERE s.account_id = $1 AND a.state <> 'deleted'
     FOR SHARE OF s`,
    [accountId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    researchId: row.research_id,
    consentVersion: row.consent_version,
    gender: row.gender,
    birthYear: row.birth_year,
    birthMonth: row.birth_month,
    pond: row.pond,
    fields: row.fields ?? null,
  };
}

export type NewEventRow = {
  at: Date;
  name: string;
  researchId: string;
  consentVersion: string;
  pond: string | null;
  ageBand: string;
  snapshot: unknown;
  props: unknown;
};

export async function insertEvent(db: Queryable, row: NewEventRow): Promise<void> {
  await db.query(
    `INSERT INTO events (at, name, research_id, consent_version, pond, age_band, snapshot, props)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
    [
      row.at,
      row.name,
      row.researchId,
      row.consentVersion,
      row.pond,
      row.ageBand,
      JSON.stringify(row.snapshot),
      JSON.stringify(row.props),
    ],
  );
}
