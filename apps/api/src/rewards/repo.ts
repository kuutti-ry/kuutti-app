import type { Queryable } from "@kuutti/db";
import type { InvitationReward, RewardKind, RewardUnits } from "@kuutti/schema";

// The invitations and the reward ledger (#107, ADR-044). Raw parameterised
// SQL, as in the other slices; every statement that reads or writes a
// person's rows names their account (rule 6), the night's count aside, which
// is nobody's request. A code is never in a statement: only its hash is.

/**
 * The caller's account row, locked against an erasure, a sanction and the
 * caller's own other requests (`FOR UPDATE`, as the e-mail's sends and the
 * exports are counted under it), with how many accounts of the identity were
 * erased before; null for an account erased already. The identity's count is
 * read here rather than through the identity slice: it is the one column of
 * that row the redeem asks, and it changes only by an erasure, which waits
 * for this lock.
 */
export async function lockAccount(
  db: Queryable,
  accountId: string,
): Promise<{ deletionCount: number } | null> {
  const { rows } = await db.query<{ deletion_count: number }>(
    `SELECT i.deletion_count FROM account a JOIN identity i ON i.id = a.identity_id
      WHERE a.id = $1 AND a.state <> 'deleted'
      FOR UPDATE OF a`,
    [accountId],
  );
  const row = rows[0];
  return row ? { deletionCount: row.deletion_count } : null;
}

/** The same without a lock, for the read of the person's own invitations. */
export async function deletionCountOf(db: Queryable, accountId: string): Promise<number | null> {
  const { rows } = await db.query<{ deletion_count: number }>(
    `SELECT i.deletion_count FROM account a JOIN identity i ON i.id = a.identity_id
      WHERE a.id = $1 AND a.state <> 'deleted'`,
    [accountId],
  );
  return rows[0]?.deletion_count ?? null;
}

/** Whether the person has redeemed an invitation, ever, counted or not. */
export async function hasRedeemed(db: Queryable, accountId: string): Promise<boolean> {
  const { rows } = await db.query("SELECT 1 FROM invitation WHERE redeemed_by_account_id = $1", [
    accountId,
  ]);
  return rows.length > 0;
}

/**
 * A new invitation, counted in the statement that inserts it: written only
 * while the person holds fewer than `limit` open ones. The caller holds the
 * account row's lock, so two creates at once are counted one after the other.
 * Null when the person holds as many as they may. Two codes alike fail the
 * unique index and the request answers 500; at fifty bits that is about one
 * create in 10^15 among the codes open at launch, and the next tap draws anew.
 */
export async function insertInvitation(
  db: Queryable,
  input: { accountId: string; codeHash: string; at: Date; limit: number },
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `WITH open AS (SELECT count(*)::int AS n FROM invitation
                    WHERE inviter_account_id = $1 AND redeemed_at IS NULL)
     INSERT INTO invitation (inviter_account_id, code_hash, created_at)
     SELECT $1, $2, $3 FROM open WHERE open.n < $4
     RETURNING id`,
    [input.accountId, input.codeHash, input.at, input.limit],
  );
  return rows[0]?.id ?? null;
}

/** The person's open invitations, newest first, at most `limit`. */
export async function listOpen(
  db: Queryable,
  accountId: string,
  limit: number,
): Promise<Array<{ id: string; createdAt: Date }>> {
  const { rows } = await db.query<{ id: string; created_at: Date }>(
    `SELECT id, created_at FROM invitation
      WHERE inviter_account_id = $1 AND redeemed_at IS NULL
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    [accountId, limit],
  );
  return rows.map((row) => ({ id: row.id, createdAt: row.created_at }));
}

/** How many of the person's invitations have counted, ever. */
export async function countCounted(db: Queryable, accountId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM invitation WHERE inviter_account_id = $1 AND counted_at IS NOT NULL",
    [accountId],
  );
  return rows[0]?.n ?? 0;
}

/** The person's units not used yet, by kind. */
export async function unspentOf(db: Queryable, accountId: string): Promise<RewardUnits> {
  const { rows } = await db.query<{ fish: number; likes: number }>(
    `SELECT count(*) FILTER (WHERE kind = 'fish')::int AS fish,
            count(*) FILTER (WHERE kind = 'like')::int AS likes
       FROM reward WHERE account_id = $1 AND spent_at IS NULL`,
    [accountId],
  );
  return { fish: rows[0]?.fish ?? 0, likes: rows[0]?.likes ?? 0 };
}

/** Withdraws an open invitation of the person's own; false for one redeemed, another's or nobody's. */
export async function deleteOpen(
  db: Queryable,
  input: { accountId: string; invitationId: string },
): Promise<boolean> {
  const result = await db.query(
    "DELETE FROM invitation WHERE id = $2 AND inviter_account_id = $1 AND redeemed_at IS NULL",
    [input.accountId, input.invitationId],
  );
  return result.rowCount === 1;
}

/**
 * Redeems the open invitation with the code's hash for the caller: false for
 * a hash nobody's open invitation has, and for the caller's own, told apart
 * nowhere (ADR-044 §6). A redeem racing another on the same code waits for
 * the row and finds it redeemed.
 */
export async function redeem(
  db: Queryable,
  input: { accountId: string; codeHash: string; at: Date },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE invitation SET redeemed_by_account_id = $1, redeemed_at = $3
      WHERE code_hash = $2 AND redeemed_at IS NULL AND inviter_account_id <> $1`,
    [input.accountId, input.codeHash, input.at],
  );
  return result.rowCount === 1;
}

/** An invitation the night may count: redeemed, not counted, by one of the redeemers it found complete. */
const COUNTABLE = `i.counted_at IS NULL AND i.redeemed_by_account_id = ANY($1::uuid[])`;

/** Who redeemed an invitation that has not counted: the people the night asks completeness of. */
export async function uncountedRedeemers(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT redeemed_by_account_id AS id FROM invitation
      WHERE counted_at IS NULL AND redeemed_by_account_id IS NOT NULL
      ORDER BY redeemed_by_account_id`,
  );
  return rows.map((row) => row.id);
}

/**
 * The inviters of the invitations the night may count, locked in id order
 * (`FOR SHARE`), before any invitation of theirs is touched: an erasure takes
 * the account first and its invitations after, and the count writes units
 * that point at the account, so the other order would leave each waiting for
 * the other.
 */
export async function lockInviters(db: Queryable, redeemers: readonly string[]): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT a.id FROM account a
      WHERE a.id IN (SELECT i.inviter_account_id FROM invitation i WHERE ${COUNTABLE})
      ORDER BY a.id FOR SHARE OF a`,
    [redeemers],
  );
  return rows.map((row) => row.id);
}

/**
 * Counts what can be counted of the locked inviters' invitations, once: a
 * second run finds `counted_at` set. Each counted invitation with its inviter.
 */
export async function markCounted(
  db: Queryable,
  input: { inviters: readonly string[]; redeemers: readonly string[]; at: Date },
): Promise<Array<{ invitationId: string; inviterId: string }>> {
  const { rows } = await db.query<{ id: string; inviter_account_id: string }>(
    `UPDATE invitation i SET counted_at = $3
      WHERE ${COUNTABLE} AND i.inviter_account_id = ANY($2::uuid[])
      RETURNING i.id, i.inviter_account_id`,
    [input.redeemers, input.inviters, input.at],
  );
  return rows.map((row) => ({ invitationId: row.id, inviterId: row.inviter_account_id }));
}

/** Each counted invitation's units for its inviter, one row a unit, as the reward reads. */
export async function insertUnits(
  db: Queryable,
  input: {
    counted: ReadonlyArray<{ invitationId: string; inviterId: string }>;
    reward: InvitationReward;
    at: Date;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO reward (account_id, kind, invitation_id, earned_at)
     SELECT c.inviter, k.kind::reward_kind, c.invitation, $3
       FROM unnest($1::uuid[], $2::uuid[]) AS c(invitation, inviter)
       CROSS JOIN (SELECT 'fish' AS kind FROM generate_series(1, $4::int)
                   UNION ALL SELECT 'like' FROM generate_series(1, $5::int)) AS k`,
    [
      input.counted.map((c) => c.invitationId),
      input.counted.map((c) => c.inviterId),
      input.at,
      input.reward.fish,
      input.reward.likes,
    ],
  );
}

/**
 * Spends the person's oldest unit of the kind not used yet on a round entry;
 * false with none left. `SKIP LOCKED`: a unit another transaction is spending
 * or giving back is not this one's to wait for.
 */
export async function spendOldest(
  db: Queryable,
  input: { accountId: string; kind: RewardKind; entryId: string; at: Date },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE reward SET spent_at = $4, spent_entry_id = $3
      WHERE account_id = $1 AND id = (
        SELECT id FROM reward WHERE account_id = $1 AND kind = $2 AND spent_at IS NULL
         ORDER BY earned_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)`,
    [input.accountId, input.kind, input.entryId, input.at],
  );
  return result.rowCount === 1;
}

/** Gives back the person's units of these kinds spent on an entry. */
export async function releaseOn(
  db: Queryable,
  input: { accountId: string; entryId: string; kinds: readonly RewardKind[] },
): Promise<number> {
  const result = await db.query(
    `UPDATE reward SET spent_at = NULL, spent_entry_id = NULL
      WHERE account_id = $1 AND spent_entry_id = $2 AND kind = ANY($3::reward_kind[])`,
    [input.accountId, input.entryId, input.kinds],
  );
  return result.rowCount ?? 0;
}

/** The round entries the person's units of a kind paid for. */
export async function paidEntries(
  db: Queryable,
  accountId: string,
  kind: RewardKind,
): Promise<string[]> {
  const { rows } = await db.query<{ spent_entry_id: string }>(
    `SELECT spent_entry_id FROM reward
      WHERE account_id = $1 AND kind = $2 AND spent_entry_id IS NOT NULL`,
    [accountId, kind],
  );
  return rows.map((row) => row.spent_entry_id);
}

/** For the export: the invitations the person made, newest first. */
export async function exportedMade(
  db: Queryable,
  accountId: string,
  limit: number,
): Promise<Array<{ createdAt: Date; redeemedAt: Date | null; countedAt: Date | null }>> {
  const { rows } = await db.query<{
    created_at: Date;
    redeemed_at: Date | null;
    counted_at: Date | null;
  }>(
    `SELECT created_at, redeemed_at, counted_at FROM invitation
      WHERE inviter_account_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [accountId, limit],
  );
  return rows.map((r) => ({
    createdAt: r.created_at,
    redeemedAt: r.redeemed_at,
    countedAt: r.counted_at,
  }));
}

/** For the export: the invitation the person joined with, its two times and nothing of whose. */
export async function exportedUsed(
  db: Queryable,
  accountId: string,
): Promise<{ redeemedAt: Date; countedAt: Date | null } | null> {
  const { rows } = await db.query<{ redeemed_at: Date; counted_at: Date | null }>(
    "SELECT redeemed_at, counted_at FROM invitation WHERE redeemed_by_account_id = $1",
    [accountId],
  );
  const row = rows[0];
  return row ? { redeemedAt: row.redeemed_at, countedAt: row.counted_at } : null;
}

/** For the export: the person's units, newest first. */
export async function exportedUnits(
  db: Queryable,
  accountId: string,
  limit: number,
): Promise<Array<{ kind: RewardKind; earnedAt: Date; spentAt: Date | null }>> {
  const { rows } = await db.query<{ kind: RewardKind; earned_at: Date; spent_at: Date | null }>(
    `SELECT kind, earned_at, spent_at FROM reward
      WHERE account_id = $1 ORDER BY earned_at DESC, id DESC LIMIT $2`,
    [accountId, limit],
  );
  return rows.map((r) => ({ kind: r.kind, earnedAt: r.earned_at, spentAt: r.spent_at }));
}

/** What an erasure did to the person's invitations and units, each side's deleted and kept. */
export type InvitationErasure = {
  units: number;
  madeDeleted: number;
  madeKept: number;
  usedDeleted: number;
  usedKept: number;
};

/**
 * Erasure (ADR-044 §10). The person's units go, by account: every unit is its
 * invitation's inviter's, so this takes all of a counted invitation's units
 * before its row is touched, and the cascade from an invitation deleted below
 * reaches nobody else's unit or notice. Of the invitations the person made,
 * the open ones go; a redeemed one stays for its redeemer with the link cut,
 * so the redeemer has still redeemed one, ever, and their export still says
 * when. The invitation the person redeemed goes until it counts, and once
 * counted stays for its inviter without the person. A row that would name
 * nobody goes on either side (`invitation_named_check`).
 */
export async function eraseOf(db: Queryable, accountId: string): Promise<InvitationErasure> {
  const units = await db.query("DELETE FROM reward WHERE account_id = $1", [accountId]);
  const madeDeleted = await db.query(
    `DELETE FROM invitation WHERE inviter_account_id = $1
        AND (redeemed_at IS NULL OR redeemed_by_account_id IS NULL)`,
    [accountId],
  );
  const madeKept = await db.query(
    "UPDATE invitation SET inviter_account_id = NULL WHERE inviter_account_id = $1",
    [accountId],
  );
  const usedDeleted = await db.query(
    `DELETE FROM invitation WHERE redeemed_by_account_id = $1
        AND (counted_at IS NULL OR inviter_account_id IS NULL)`,
    [accountId],
  );
  const usedKept = await db.query(
    "UPDATE invitation SET redeemed_by_account_id = NULL WHERE redeemed_by_account_id = $1",
    [accountId],
  );
  return {
    units: units.rowCount ?? 0,
    madeDeleted: madeDeleted.rowCount ?? 0,
    madeKept: madeKept.rowCount ?? 0,
    usedDeleted: usedDeleted.rowCount ?? 0,
    usedKept: usedKept.rowCount ?? 0,
  };
}
