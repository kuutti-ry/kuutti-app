import { type Queryable, transaction } from "@kuutti/db";
import { wasShown } from "../media/index.ts";

/**
 * Blocks (#84, ADR-030, features/safety/blocks.feature): a person blocks
 * somebody whose card they were shown, and from then on neither is shown to
 * the other, anywhere a person is shown to a person (rule 7). The row is
 * between the two identities, so it holds for a later account of either, and
 * it is final: no list, no unblock. Nobody is told, and nothing counts
 * blocks: the filters read them (`inEachOthersPool`, `blocked_between` of
 * migration 0051) and nothing else does (no-signal.test.ts).
 */

/**
 * The block from the caller's identity to the subject's; a second one, or
 * one the other set first, changes nothing that anybody can tell. The caller
 * is named in the statement and must be live (rule 6, #51). Inside the
 * caller's transaction: a report writes it with the report. False when the
 * caller is erased.
 */
export async function insertBlock(
  db: Queryable,
  input: { blockerAccountId: string; blockedAccountId: string; at: Date },
): Promise<boolean> {
  const { rows } = await db.query<{ live: boolean }>(
    `WITH me AS (SELECT identity_id FROM account WHERE id = $1 AND state <> 'deleted'),
          ins AS (INSERT INTO block (blocker_identity_id, blocked_identity_id, created_at)
                  SELECT me.identity_id, them.identity_id, $3 FROM me, account them
                  WHERE them.id = $2 AND them.identity_id <> me.identity_id
                  ON CONFLICT (blocker_identity_id, blocked_identity_id) DO NOTHING
                  RETURNING 1)
     SELECT EXISTS (SELECT 1 FROM me) AS live`,
    [input.blockerAccountId, input.blockedAccountId, input.at],
  );
  return rows[0]?.live === true;
}

/**
 * Whether a block stands between the two accounts, set by either, that was
 * set while both of them existed (ADR-030 §6). It is proof of contact as good
 * as a card shown: whoever set it was shown the other, and so the blocked
 * person can block back, or report, whether or not the other is still there
 * or still has the photos that were shown. A later account of either identity
 * is not one the block was set between: for it the block proves nothing, and
 * the answer is a stranger's (the block itself holds for it all the same,
 * `blocked_between`). Scoped by the caller's account (rule 6).
 */
export async function blockStandsBetween(
  db: Queryable,
  input: { callerAccountId: string; otherAccountId: string },
): Promise<boolean> {
  const { rows } = await db.query<{ stands: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM account me, account them, block bl
       WHERE me.id = $1 AND them.id = $2
         AND ((bl.blocker_identity_id = me.identity_id AND bl.blocked_identity_id = them.identity_id)
           OR (bl.blocker_identity_id = them.identity_id AND bl.blocked_identity_id = me.identity_id))
         AND me.registered_at <= bl.created_at AND them.registered_at <= bl.created_at) AS stands`,
    [input.callerAccountId, input.otherAccountId],
  );
  return rows[0]?.stands === true;
}

/**
 * A block from a card: only of somebody whose card the caller was shown
 * (`wasShown`), or with whom a block stands already, set by either while both
 * accounts existed (`blockStandsBetween`). False, and nothing written,
 * otherwise: never shown, oneself, nobody, a later account of somebody
 * blocked, or the caller erased meanwhile, all alike. The block is asked
 * before the card, so a block repeated, or a block back, answers 204 whether
 * or not the other person, or their photos, are still there (ADR-030 §6).
 */
export async function recordBlock(
  db: Queryable,
  input: { blockerAccountId: string; blockedAccountId: string; at: Date },
): Promise<boolean> {
  return transaction(db, async (tx) => {
    const proven =
      (await blockStandsBetween(tx, {
        callerAccountId: input.blockerAccountId,
        otherAccountId: input.blockedAccountId,
      })) ||
      (await wasShown(tx, {
        viewerAccountId: input.blockerAccountId,
        subjectAccountId: input.blockedAccountId,
      }));
    return proven && (await insertBlock(tx, input));
  });
}

/**
 * The blocks the person's identity set, for their export (ADR-030 §8):
 * dates only, newest first, never whom; from this account or an earlier one
 * of the identity, the scope the block holds in, and the reports' too. A
 * block set against the person is not theirs and stays out. Scoped by the
 * caller's account (rule 6).
 */
export async function listBlocksOfAccount(
  db: Queryable,
  accountId: string,
  limit: number,
): Promise<Array<{ at: Date }>> {
  const { rows } = await db.query<{ created_at: Date }>(
    `SELECT bl.created_at FROM block bl
     JOIN account me ON me.identity_id = bl.blocker_identity_id
     WHERE me.id = $1
     ORDER BY bl.created_at DESC, bl.id DESC LIMIT $2`,
    [accountId, limit],
  );
  return rows.map((row) => ({ at: row.created_at }));
}
