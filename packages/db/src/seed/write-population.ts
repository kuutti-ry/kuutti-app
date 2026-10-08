import { createHash } from "node:crypto";
import type { Queryable } from "../pool.ts";
import { transaction } from "../pool.ts";
import { DEMO_LABEL_PREFIX, type SyntheticPerson } from "./population.ts";

/**
 * Writes the synthetic population (#73, ADR-014) and removes the one that was
 * there. Replacing, not adding: the command can be run again, with another
 * size or another seed, and what is in the database is what the generator
 * says, no more.
 *
 * A synthetic identity cannot be confused with a person. Its `hetu_hmac` is a
 * hash of its label, as the seed's own identities are, so no bank login maps
 * to it; and `broker_subject` carries a mark. The removal needs both: the
 * mark alone is the ID token's `sub`, which a login stores as the broker sent
 * it, so a subject that happens to begin with the mark must never be enough
 * to delete somebody. An identity that a login made cannot carry the hash of
 * its own label, and has the time of its authentication, which a synthetic
 * one has not.
 *
 * Raw parameterised SQL over the Queryable seam, as the API's repositories
 * use: a test hands in a rolled-back transaction. No statement takes input
 * from a request. This runs from the command line against a local database
 * or a pull request's own; the command refuses an environment that is not
 * allowed before it connects, and a deployed server after it has connected
 * and asked, before anything is written or removed (command.ts).
 */

/** What marks an identity as made by this module. */
export const DEMO_SUBJECT_PREFIX = "kuutti-demo:";

export const demoHetuHmac = (label: string): string =>
  createHash("sha256").update(`kuutti demo identity: ${label}`).digest("hex");

/** The versions the rows name: the two consents of onboarding and the special-category wording of the profile (ADR-019 §4). */
export type ConsentVersions = Readonly<Record<"terms" | "privacy" | "special_category", string>>;

/** `spared`: identities that carry the mark and are not synthetic; never touched. */
export type RemoveResult = { removed: number; spared: number };

export type WriteResult = RemoveResult & { written: number; ponds: Record<string, number> };

/** The tables that hold rows of an account, in an order in which they can be emptied. */
const ACCOUNT_TABLES = [
  "gate",
  "photo_access",
  "card_shown",
  "photo",
  "research_subject",
  "consent",
  "preferences",
  "profile",
  "session",
  "auth_request",
] as const;

/** Removes every synthetic identity with everything of its accounts. */
export async function removePopulation(db: Queryable): Promise<RemoveResult> {
  return transaction(db, async (tx) => {
    // Synthetic is who carries the mark, the hash of the label behind the
    // mark, and no time of authentication. The hash is computed by the server
    // from the row's own subject, the way demoHetuHmac computes it.
    const { rows } = await tx.query<{ id: string; synthetic: boolean }>(
      `SELECT id,
              (authenticated_at IS NULL
               AND hetu_hmac = encode(sha256(convert_to(
                     'kuutti demo identity: ' || substr(broker_subject, length($2) + 1), 'UTF8')), 'hex')
              ) AS synthetic
       FROM identity WHERE broker_subject LIKE $1`,
      [`${DEMO_SUBJECT_PREFIX}%`, DEMO_SUBJECT_PREFIX],
    );
    const identities = rows.filter((r) => r.synthetic).map((r) => r.id);
    const spared = rows.length - identities.length;
    await deleteIdentities(tx, identities);
    return { removed: identities.length, spared };
  });
}

/**
 * Deletes the identities with their accounts and everything of those: rows,
 * not tombstones. For people who never were (the population) and for the
 * personas of the mock bank after the erasure path has run for them; the
 * callers decide who that is, this only deletes in an order that holds. A
 * row in a table this does not know (the append-only audit log, a staff
 * role) stops it on the foreign key, and the transaction with it.
 */
export async function deleteIdentities(
  tx: Queryable,
  identities: readonly string[],
): Promise<void> {
  if (identities.length === 0) return;
  const accounts = (
    await tx.query<{ id: string }>("SELECT id FROM account WHERE identity_id = ANY($1)", [
      identities,
    ])
  ).rows.map((r) => r.id);
  for (const table of ACCOUNT_TABLES) {
    await tx.query(`DELETE FROM ${table} WHERE account_id = ANY($1)`, [accounts]);
  }
  await tx.query("DELETE FROM auth_request WHERE identity_id = ANY($1)", [identities]);
  await tx.query("DELETE FROM account WHERE id = ANY($1)", [accounts]);
  await tx.query("DELETE FROM identity WHERE id = ANY($1)", [identities]);
}

export async function writePopulation(
  db: Queryable,
  people: readonly SyntheticPerson[],
  consentVersions: ConsentVersions,
): Promise<WriteResult> {
  for (const person of people) {
    if (!person.label.startsWith(DEMO_LABEL_PREFIX)) {
      throw new Error(`not a synthetic person: ${person.label}`);
    }
  }
  return transaction(db, async (tx) => {
    const { removed, spared } = await removePopulation(tx);
    const pondIds = new Map(
      (await tx.query<{ id: string; slug: string }>("SELECT id, slug FROM ponds")).rows.map((r) => [
        r.slug,
        r.id,
      ]),
    );
    const ponds: Record<string, number> = {};
    for (const person of people) {
      const pondId = person.pond === null ? null : pondIds.get(person.pond);
      if (pondId === undefined) throw new Error(`no pond ${person.pond}: run the seed first`);
      if (person.pond !== null) ponds[person.pond] = (ponds[person.pond] ?? 0) + 1;

      const identity = await tx.query<{ id: string }>(
        `INSERT INTO identity (hetu_hmac, standing, broker_subject, created_at)
         VALUES ($1, 'ok', $2, $3) RETURNING id`,
        [demoHetuHmac(person.label), `${DEMO_SUBJECT_PREFIX}${person.label}`, person.registeredAt],
      );
      const account = await tx.query<{ id: string }>(
        `INSERT INTO account
           (identity_id, state, state_changed_at, birth_year, birth_month, gender, pond_id, registered_at)
         VALUES ($1, $2::account_state, $3, $4, $5, $6::gender, $7, $8) RETURNING id`,
        [
          identity.rows[0]?.id,
          person.state,
          person.consents[0]?.givenAt ?? null,
          person.birthYear,
          person.birthMonth,
          person.gender,
          pondId,
          person.registeredAt,
        ],
      );
      const accountId = account.rows[0]?.id;
      if (!accountId) throw new Error(`account of ${person.label} not written`);

      for (const consent of person.consents) {
        await tx.query(
          `INSERT INTO consent (account_id, kind, version, locale_shown, given_at)
           VALUES ($1, $2::consent_kind, $3, $4, $5)`,
          [
            accountId,
            consent.kind,
            consentVersions[consent.kind],
            consent.localeShown,
            consent.givenAt,
          ],
        );
      }
      if (person.preferences) {
        for (const [field, value] of [
          ["seeks", person.preferences.seeks],
          ["age_window", person.preferences.ageWindow],
        ] as const) {
          await tx.query(
            `INSERT INTO preferences (account_id, field, value, mode, created_at, updated_at)
             VALUES ($1, $2, $3::jsonb, 'hard', $4, $4)`,
            [accountId, field, JSON.stringify(value), person.registeredAt],
          );
        }
      }
      if (person.profile) {
        const consentedAt = person.profile.specialCategoryConsentedAt;
        await tx.query(
          `INSERT INTO profile
             (account_id, display_name, bio, bio_preset, fields, prompts,
              special_category_consent_version, special_category_consented_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $9)`,
          [
            accountId,
            person.profile.displayName,
            person.profile.bio,
            person.profile.bioPreset,
            JSON.stringify(person.profile.fields),
            JSON.stringify(person.profile.prompts),
            consentedAt ? consentVersions.special_category : null,
            consentedAt,
            person.registeredAt,
          ],
        );
      }
    }
    return { removed, spared, written: people.length, ponds };
  });
}
