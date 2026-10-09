import type { Queryable } from "@kuutti/db";
import {
  type BioPreset,
  type Gender,
  PROFILE_FIELD_KEYS,
  PROFILE_FIELDS,
  type ProfileDocument,
  type ProfileFields,
  type ProfileUpdate,
  PromptAnswer,
  SPECIAL_CATEGORY_FIELDS,
} from "@kuutti/schema";

// Raw parameterised SQL as in the other slices: Deps.db is the Queryable seam
// the test harness hands a rolled-back transaction through. Every statement
// about the caller's own profile carries the caller's account id in its WHERE
// clause (rule 6). The one read by another account's id, findCardSubject, is
// the card: what the round builder of M4 serves after the matching rules
// chose the subject, and what the owner previews for themselves; no route
// serves another person's card in M3 (ADR-009).

type Row = Record<string, unknown>;

export type ProfileRow = ProfileDocument & {
  accountId: string;
  /** Stored values the registry no longer knows (an option removed): read as unanswered; the caller logs the keys. */
  dropped: string[];
};

/**
 * The row was written by this API against the registry, so a value that no
 * longer parses is a removed option or prompt. Each field and each prompt is
 * read on its own, so one stale value costs that value alone, never the
 * whole document (ADR-009 §1: removing an option is a data change).
 */
function storedFields(raw: unknown): { fields: ProfileFields; dropped: string[] } {
  const source = (raw ?? {}) as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const key of PROFILE_FIELD_KEYS) {
    if (source[key] === undefined) continue;
    const parsed = PROFILE_FIELDS[key].schema.safeParse(source[key]);
    if (parsed.success) fields[key] = parsed.data;
    else dropped.push(`fields.${key}`);
  }
  for (const key of Object.keys(source)) {
    if (!(PROFILE_FIELD_KEYS as readonly string[]).includes(key)) dropped.push(`fields.${key}`);
  }
  return { fields: fields as ProfileFields, dropped };
}

function storedPrompts(raw: unknown): { prompts: ProfileDocument["prompts"]; dropped: string[] } {
  const source = Array.isArray(raw) ? raw : [];
  const prompts: ProfileDocument["prompts"] = [];
  const dropped: string[] = [];
  source.forEach((entry, index) => {
    const parsed = PromptAnswer.safeParse(entry);
    if (parsed.success) prompts.push(parsed.data);
    else dropped.push(`prompts.${index}`);
  });
  return { prompts, dropped };
}

/** How many prompts of a stored document still count: the ones the registry still knows (#54 reads many rows at once). */
export const answeredPromptsOf = (raw: unknown): number => storedPrompts(raw).prompts.length;

const profileFrom = (r: Row): ProfileRow => {
  const fields = storedFields(r.fields);
  const prompts = storedPrompts(r.prompts);
  return {
    accountId: r.account_id as string,
    displayName: r.display_name as string,
    bio: (r.bio as string | null) ?? null,
    bioPreset: (r.bio_preset as BioPreset | null) ?? null,
    fields: fields.fields,
    prompts: prompts.prompts,
    dropped: [...fields.dropped, ...prompts.dropped],
    specialCategoryConsent:
      typeof r.special_category_consent_version === "string" &&
      r.special_category_consented_at instanceof Date
        ? {
            version: r.special_category_consent_version,
            at: r.special_category_consented_at.toISOString(),
          }
        : null,
    updatedAt: (r.updated_at as Date).toISOString(),
  };
};

const COLUMNS =
  "account_id, display_name, bio, bio_preset, fields, prompts, special_category_consent_version, special_category_consented_at, updated_at";

export async function findProfile(db: Queryable, accountId: string): Promise<ProfileRow | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM profile WHERE account_id = $1`, [
    accountId,
  ]);
  return rows[0] ? profileFrom(rows[0]) : null;
}

/**
 * The whole document, inserted or replaced; a tombstone writes nothing (#51).
 * The account row is taken under lock first, the same lock erasure takes, so
 * a save racing an erasure either lands before the deletes or sees the
 * tombstone and writes nothing. The consent's time is kept when the version
 * is unchanged and set anew when it changes; null withdraws it.
 */
export async function upsertProfile(
  db: Queryable,
  accountId: string,
  update: ProfileUpdate,
  at: Date,
): Promise<ProfileRow | null> {
  const { rows } = await db.query<Row>(
    `WITH live AS (SELECT id FROM account WHERE id = $1 AND state <> 'deleted' FOR UPDATE)
     INSERT INTO profile (account_id, display_name, bio, bio_preset, fields, prompts,
                          special_category_consent_version, special_category_consented_at,
                          created_at, updated_at)
     SELECT $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, CASE WHEN $7::text IS NULL THEN NULL ELSE $8::timestamptz END, $8, $8
     FROM live
     ON CONFLICT (account_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       bio = EXCLUDED.bio,
       bio_preset = EXCLUDED.bio_preset,
       fields = EXCLUDED.fields,
       prompts = EXCLUDED.prompts,
       special_category_consent_version = EXCLUDED.special_category_consent_version,
       special_category_consented_at = CASE
         WHEN EXCLUDED.special_category_consent_version IS NULL THEN NULL
         WHEN profile.special_category_consent_version = EXCLUDED.special_category_consent_version
           THEN profile.special_category_consented_at
         ELSE EXCLUDED.special_category_consented_at END,
       updated_at = EXCLUDED.updated_at
     RETURNING ${COLUMNS}`,
    [
      accountId,
      update.displayName,
      update.bio,
      update.bioPreset,
      JSON.stringify(update.fields),
      JSON.stringify(update.prompts),
      update.specialCategoryConsent?.version ?? null,
      at,
    ],
  );
  return rows[0] ? profileFrom(rows[0]) : null;
}

/** Erasure (#51, ADR-007): the profile goes with the account. */
export async function deleteProfileOfAccount(db: Queryable, accountId: string): Promise<number> {
  const result = await db.query("DELETE FROM profile WHERE account_id = $1", [accountId]);
  return result.rowCount ?? 0;
}

export type CardSubject = {
  accountId: string;
  state: string;
  birthYear: number | null;
  birthMonth: number | null;
  /** Self-declared, display only (ADR-019 §1). */
  gender: Gender | null;
  profile: ProfileRow | null;
};

/**
 * The account and profile behind a card. Read by the subject's id: the
 * viewer's right to see it is decided by the caller (the owner previewing
 * themselves, or M4's round after the matching rules), and recorded by
 * recordCardServed in the media slice for anyone but the owner.
 */
export async function findCardSubject(
  db: Queryable,
  subjectAccountId: string,
): Promise<CardSubject | null> {
  const { rows } = await db.query<Row>(
    `SELECT a.id, a.state, a.birth_year, a.birth_month, a.gender,
            p.account_id, p.display_name, p.bio, p.bio_preset, p.fields, p.prompts,
            p.special_category_consent_version, p.special_category_consented_at, p.updated_at
     FROM account a LEFT JOIN profile p ON p.account_id = a.id
     WHERE a.id = $1`,
    [subjectAccountId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    accountId: r.id as string,
    state: r.state as string,
    birthYear: (r.birth_year as number | null) ?? null,
    birthMonth: (r.birth_month as number | null) ?? null,
    gender: (r.gender as Gender | null) ?? null,
    profile: r.account_id ? profileFrom(r) : null,
  };
}

/**
 * Withdrawing the special-category consent takes the article 9 answers with
 * it (ADR-019 §4, #146): politics and religion leave the document and the
 * consent columns are cleared; everything else stays. Under the account row's
 * lock like every writer; a tombstone changes nothing.
 */
export async function clearSpecialCategoryAnswers(
  db: Queryable,
  accountId: string,
  at: Date,
): Promise<boolean> {
  const result = await db.query(
    `WITH live AS (SELECT id FROM account WHERE id = $1 AND state <> 'deleted' FOR UPDATE)
     UPDATE profile SET fields = fields - $2::text[],
                        special_category_consent_version = NULL,
                        special_category_consented_at = NULL,
                        updated_at = $3
     WHERE account_id IN (SELECT id FROM live)`,
    [accountId, SPECIAL_CATEGORY_FIELDS, at],
  );
  return (result.rowCount ?? 0) > 0;
}
