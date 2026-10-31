import { createHash, randomUUID } from "node:crypto";
import type { Queryable } from "@kuutti/db";
import { CONSENT_VERSIONS } from "@kuutti/i18n";
import { completeProfiles, consentsOf, pondNamed } from "./people.ts";

/**
 * Invitations and the reward ledger as a test of any slice sets them up
 * (#107, ADR-044): plain SQL like `signedInAccount`, since a test of one
 * slice may not import another's internals. Nothing here draws or holds a
 * real code: the invitations written are known by their hash alone.
 */

/** The person's profile and onboarding are complete (ADR-060 §7), in a pond of their own; a registered account becomes active, as onboarding makes it. */
export async function completed(db: Queryable, accountId: string): Promise<void> {
  const pondId = await pondNamed(db, `invite-${randomUUID().slice(0, 8)}`);
  await db.query(
    `UPDATE account SET pond_id = $2, gender = 'woman',
            state = CASE WHEN state = 'registered' THEN 'active' ELSE state END
      WHERE id = $1`,
    [accountId, pondId],
  );
  await consentsOf(db, [accountId]);
  await completeProfiles(db, [accountId]);
}

/** The current terms and privacy consents, as onboarding leaves them after its welcome. */
export async function consented(db: Queryable, accountId: string): Promise<void> {
  await db.query(
    `INSERT INTO consent (account_id, kind, version, locale_shown)
     VALUES ($1, 'terms', $2, 'fi'), ($1, 'privacy', $3, 'fi')`,
    [accountId, CONSENT_VERSIONS.terms, CONSENT_VERSIONS.privacy],
  );
}

/** The SHA-256 a code is kept as, here of any text: the tests' invitations carry no code. */
export const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/** An invitation of `inviter`'s written straight in, open, or redeemed by somebody and counted at a time. */
export async function invitationOf(
  db: Queryable,
  inviter: string,
  options: { codeHash?: string; redeemedBy?: string; at?: Date; countedAt?: Date } = {},
): Promise<string> {
  const at = options.at ?? new Date();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO invitation (inviter_account_id, code_hash, created_at, redeemed_by_account_id, redeemed_at, counted_at)
     VALUES ($1, $2, $3, $4::uuid, CASE WHEN $4::uuid IS NULL THEN NULL ELSE $3::timestamptz END, $5)
     RETURNING id`,
    [
      inviter,
      options.codeHash ?? hashOf(randomUUID()),
      at,
      options.redeemedBy ?? null,
      options.countedAt ?? null,
    ],
  );
  return rows[0]?.id as string;
}

/**
 * Units the person earned, as the night's count leaves them: an invitation of
 * theirs redeemed by a person of its own and counted, with one row a unit.
 * The invitation's id.
 */
export async function earnedUnits(
  db: Queryable,
  accountId: string,
  units: { fish?: number; likes?: number },
  at: Date = new Date(),
): Promise<string> {
  const identity = await db.query<{ id: string }>(
    "INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id",
    [`kuutti test invitee ${randomUUID()}`],
  );
  const redeemer = await db.query<{ id: string }>(
    "INSERT INTO account (identity_id, state, birth_year, birth_month) VALUES ($1, 'active', 1990, 6) RETURNING id",
    [identity.rows[0]?.id],
  );
  const invitationId = await invitationOf(db, accountId, {
    redeemedBy: redeemer.rows[0]?.id,
    at,
    countedAt: at,
  });
  await db.query(
    `INSERT INTO reward (account_id, kind, invitation_id, earned_at)
     SELECT $1, k.kind::reward_kind, $2, $3
       FROM (SELECT 'fish' AS kind FROM generate_series(1, $4::int)
             UNION ALL SELECT 'like' FROM generate_series(1, $5::int)) AS k`,
    [accountId, invitationId, at, units.fish ?? 0, units.likes ?? 0],
  );
  return invitationId;
}

/** The person's units as stored, oldest first, fish before likes of one time: what each is and whether, and on what, it was spent. */
export async function unitsOf(
  db: Queryable,
  accountId: string,
): Promise<Array<{ kind: string; spent: boolean; entryId: string | null }>> {
  const { rows } = await db.query<{
    kind: string;
    spent_at: Date | null;
    spent_entry_id: string | null;
  }>(
    `SELECT kind, spent_at, spent_entry_id FROM reward
      WHERE account_id = $1 ORDER BY earned_at, kind::text, id`,
    [accountId],
  );
  return rows.map((row) => ({
    kind: row.kind,
    spent: row.spent_at !== null,
    entryId: row.spent_entry_id,
  }));
}
