import type { Queryable } from "@kuutti/db";
import type { AccountState, IdentityStanding } from "@kuutti/schema";

// The account's state and the identity's standing, settled from the
// sanctions still open (#307, ADR-024 §2). Raw parameterised SQL through
// Queryable, as identity/repo.ts does and for its reason: the test harness
// hands a rolled-back transaction through the same seam. The safety slice keeps the
// sanction rows and counts what is open; this slice owns the two columns and
// the sessions, and is the one writer of a standing. Never a stored "state
// before" popped on a lift: two sanctions overlap, and only a recomputation
// from what is open is right when one of them ends.

/** What the open sanctions add up to, as the safety slice counts them. */
export type OpenSanctions = {
  /** An open ban of the identity, on any of its accounts. */
  ban: boolean;
  /** The latest end of the identity's open suspensions; null when none is open. */
  suspensionEndsAt: Date | null;
  /** An open shadow ban of this account. */
  shadowBan: boolean;
};

export type AccountStanding = {
  state: AccountState;
  pausedFrom: AccountState | null;
  sanctionedFrom: AccountState | null;
};

export type Settled = AccountStanding & {
  standing: IdentityStanding;
  suspensionEndsAt: Date | null;
};

/** What the account would be without any sanction: `registered`, `active` or `paused`. */
function baseOf(current: AccountStanding): AccountState {
  switch (current.state) {
    case "suspended":
    case "banned":
      // A row set by hand before the column existed (the demo's old ban, a test) reads as active.
      return current.sanctionedFrom ?? "active";
    case "registered":
    case "paused":
      return current.state;
    default:
      return "active";
  }
}

/**
 * The pure half: from the account as it is and what is open, what it must be.
 * A tombstone's state never changes (the standing still does, by the caller).
 * A registered account stays registered under a shadow ban; its activation
 * honours the ban (`activateAccount`).
 */
export function settle(current: AccountStanding, open: OpenSanctions): Settled {
  const standing: IdentityStanding = open.ban
    ? "banned"
    : open.suspensionEndsAt !== null
      ? "suspended"
      : "ok";
  const suspensionEndsAt = standing === "suspended" ? open.suspensionEndsAt : null;
  if (current.state === "deleted") return { ...current, standing, suspensionEndsAt };
  const base = baseOf(current);
  if (standing !== "ok") {
    return {
      state: standing,
      pausedFrom: current.pausedFrom,
      sanctionedFrom: base,
      standing,
      suspensionEndsAt,
    };
  }
  const shadowOrActive: AccountState = open.shadowBan ? "shadow_banned" : "active";
  if (base === "paused") {
    return {
      state: "paused",
      pausedFrom: shadowOrActive,
      sanctionedFrom: null,
      standing,
      suspensionEndsAt,
    };
  }
  return {
    state: base === "registered" ? "registered" : shadowOrActive,
    pausedFrom: null,
    sanctionedFrom: null,
    standing,
    suspensionEndsAt,
  };
}

/** What the person can tell from their own state: a shadow ban reads as active (#105). */
export function visibleState(state: AccountState): AccountState {
  return state === "shadow_banned" ? "active" : state;
}

/**
 * The first statements of every change to a sanction: every account of the
 * identity under lock in id order, then the identity row. A ban set through
 * an erased account must settle the identity's live account too, and two
 * writers reaching one person through two accounts must not overwrite each
 * other's standing; one lock order for all of them, account rows before the
 * identity as the erasure takes them. Null when there is no such account; a
 * tombstone comes back, since a ban still binds its identity.
 */
export async function lockAccountForSanction(
  db: Queryable,
  accountId: string,
): Promise<{
  identityId: string;
  state: AccountState;
  accounts: { id: string; state: AccountState }[];
} | null> {
  const { rows: found } = await db.query<{ identity_id: string }>(
    "SELECT identity_id FROM account WHERE id = $1",
    [accountId],
  );
  const identityId = found[0]?.identity_id;
  if (!identityId) return null;
  const { rows } = await db.query<{ id: string; state: AccountState }>(
    "SELECT id, state FROM account WHERE identity_id = $1 ORDER BY id FOR UPDATE",
    [identityId],
  );
  await db.query("SELECT 1 FROM identity WHERE id = $1 FOR UPDATE", [identityId]);
  const target = rows.find((row) => row.id === accountId);
  if (!target) return null;
  return { identityId, state: target.state, accounts: rows };
}

/**
 * The database half, inside the caller's transaction and after
 * `lockAccountForSanction`: reads the row, settles it, writes what moved. The
 * standing's date moves with the standing; the state's date only when what
 * the person can see moves, so a shadow ban moves no date anywhere the person
 * reads it.
 */
export async function settleStanding(
  db: Queryable,
  input: { accountId: string; open: OpenSanctions; at: Date },
): Promise<Settled> {
  const { rows } = await db.query<{
    identity_id: string;
    state: AccountState;
    paused_from: AccountState | null;
    sanctioned_from: AccountState | null;
  }>("SELECT identity_id, state, paused_from, sanctioned_from FROM account WHERE id = $1", [
    input.accountId,
  ]);
  const row = rows[0];
  if (!row) throw new Error(`settleStanding: no account ${input.accountId}`);
  const current: AccountStanding = {
    state: row.state,
    pausedFrom: row.paused_from,
    sanctionedFrom: row.sanctioned_from,
  };
  const next = settle(current, input.open);
  await db.query(
    `UPDATE identity SET
       standing_changed_at = CASE WHEN standing <> $2 THEN $4 ELSE standing_changed_at END,
       standing = $2, suspension_ends_at = $3
     WHERE id = $1`,
    [row.identity_id, next.standing, next.suspensionEndsAt, input.at],
  );
  if (current.state !== "deleted") {
    const seen = visibleState(current.state) !== visibleState(next.state);
    await db.query(
      `UPDATE account SET state = $2, paused_from = $3, sanctioned_from = $4,
         state_changed_at = CASE WHEN $5 THEN $6 ELSE state_changed_at END
       WHERE id = $1 AND state <> 'deleted'`,
      [input.accountId, next.state, next.pausedFrom, next.sanctionedFrom, seen, input.at],
    );
  }
  return next;
}

/**
 * Every session a suspension or a ban ends (ADR-024 §4): the product sessions
 * of the identity's live accounts, revoked with the reason `sanction`, and
 * every panel session of the identity. The guard already refuses both
 * states; the revocation is what keeps a lift from bringing old devices back.
 * A tombstone has no product session left, so callers pass live accounts only.
 */
export async function endSessionsForSanction(
  db: Queryable,
  input: { accountIds: readonly string[]; identityId: string; at: Date },
): Promise<{ sessions: number; adminSessions: number }> {
  const sessions =
    input.accountIds.length > 0
      ? await db.query(
          `UPDATE session SET revoked_at = $2, revoked_reason = 'sanction'
           WHERE account_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
          [input.accountIds, input.at],
        )
      : { rowCount: 0 };
  const admin = await db.query(
    "UPDATE admin_session SET revoked_at = $2 WHERE identity_id = $1 AND revoked_at IS NULL",
    [input.identityId, input.at],
  );
  return { sessions: sessions.rowCount ?? 0, adminSessions: admin.rowCount ?? 0 };
}
