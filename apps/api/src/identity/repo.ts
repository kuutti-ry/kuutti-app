import {
  type Account,
  type AuthRequest,
  type Identity,
  type Queryable,
  transaction,
} from "@kuutti/db";
import type { ModeratorRole } from "@kuutti/schema";

// Raw parameterised SQL rather than the Drizzle builder (rules/api.md asks for
// a reason): `Deps.db` is the `Queryable` seam through which the test harness
// hands in one rolled-back transaction per test, and Drizzle's node-postgres
// driver wants a Pool or Client, not that seam. Every statement here is keyed
// by a primary or unique key; none reads user data by anything a request
// controls except the state and the code hash, which are the keys of the
// login attempt itself.

type Row = Record<string, unknown>;

const identityFrom = (r: Row): Identity => ({
  id: r.id as string,
  hetuHmac: r.hetu_hmac as string,
  standing: r.standing as Identity["standing"],
  standingChangedAt: (r.standing_changed_at as Date | null) ?? null,
  brokerSubject: (r.broker_subject as string | null) ?? null,
  brokerSessionIndex: (r.broker_session_index as string | null) ?? null,
  brokerTokenId: (r.broker_token_id as string | null) ?? null,
  authenticatedAt: (r.authenticated_at as Date | null) ?? null,
  acr: (r.acr as string | null) ?? null,
  amr: (r.amr as string[] | null) ?? null,
  deletionCount: r.deletion_count as number,
  reregisterAfter: (r.reregister_after as Date | null) ?? null,
  refusedAttempts: r.refused_attempts as number,
  createdAt: r.created_at as Date,
});

const accountFrom = (r: Row): Account => ({
  id: r.id as string,
  identityId: r.identity_id as string,
  state: r.state as Account["state"],
  stateChangedAt: (r.state_changed_at as Date | null) ?? null,
  birthYear: (r.birth_year as number | null) ?? null,
  birthMonth: (r.birth_month as number | null) ?? null,
  gender: (r.gender as Account["gender"]) ?? null,
  pondId: (r.pond_id as string | null) ?? null,
  genderChangedAt: (r.gender_changed_at as Date | null) ?? null,
  seeksChangedAt: (r.seeks_changed_at as Date | null) ?? null,
  email: (r.email as string | null) ?? null,
  registeredAt: r.registered_at as Date,
  deletedAt: (r.deleted_at as Date | null) ?? null,
});

const authRequestFrom = (r: Row): AuthRequest => ({
  id: r.id as string,
  state: r.state as string,
  nonce: r.nonce as string,
  platform: r.platform as string,
  locale: (r.locale as string | null) ?? null,
  createdAt: r.created_at as Date,
  expiresAt: r.expires_at as Date,
  codeHash: (r.code_hash as string | null) ?? null,
  codeExpiresAt: (r.code_expires_at as Date | null) ?? null,
  codeUsedAt: (r.code_used_at as Date | null) ?? null,
  accountId: (r.account_id as string | null) ?? null,
  outcome: (r.outcome as string | null) ?? null,
  identityId: (r.identity_id as string | null) ?? null,
});

export type BrokerReference = {
  brokerSubject: string;
  brokerSessionIndex: string | null;
  brokerTokenId: string | null;
  authenticatedAt: Date;
  acr: string;
  amr: string[];
};

export async function insertAuthRequest(
  db: Queryable,
  input: { state: string; nonce: string; platform: string; locale: string | null; expiresAt: Date },
): Promise<void> {
  await db.query(
    "INSERT INTO auth_request (state, nonce, platform, locale, expires_at) VALUES ($1, $2, $3, $4, $5)",
    [input.state, input.nonce, input.platform, input.locale, input.expiresAt],
  );
}

export async function findAuthRequestByState(
  db: Queryable,
  state: string,
): Promise<AuthRequest | null> {
  const { rows } = await db.query<Row>("SELECT * FROM auth_request WHERE state = $1", [state]);
  return rows[0] ? authRequestFrom(rows[0]) : null;
}

export async function findAuthRequestByCodeHash(
  db: Queryable,
  codeHash: string,
): Promise<AuthRequest | null> {
  const { rows } = await db.query<Row>("SELECT * FROM auth_request WHERE code_hash = $1", [
    codeHash,
  ]);
  return rows[0] ? authRequestFrom(rows[0]) : null;
}

/**
 * Publishes the one-time code for the account the callback resolved. False
 * when the account was erased between the resolution and this statement
 * (#51): no code is attached to a tombstone, and the caller resolves again,
 * which now reads the cooldown.
 */
export async function attachCode(
  db: Queryable,
  input: { id: string; codeHash: string; codeExpiresAt: Date; accountId: string; outcome: string },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE auth_request SET code_hash = $2, code_expires_at = $3, account_id = $4, outcome = $5
     WHERE id = $1 AND EXISTS (SELECT 1 FROM account WHERE id = $4 AND state <> 'deleted')`,
    [input.id, input.codeHash, input.codeExpiresAt, input.accountId, input.outcome],
  );
  return result.rowCount === 1;
}

/** Ends a login attempt without a code: the person cancelled at the bank. */
export async function expireAuthRequest(db: Queryable, id: string, at: Date): Promise<void> {
  await db.query("UPDATE auth_request SET expires_at = $2 WHERE id = $1", [id, at]);
}

/** Marks the code used; the row count says whether this call was the first to. */
export async function consumeCode(db: Queryable, id: string, at: Date): Promise<boolean> {
  const result = await db.query(
    "UPDATE auth_request SET code_used_at = $2 WHERE id = $1 AND code_used_at IS NULL",
    [id, at],
  );
  return result.rowCount === 1;
}

export async function findIdentityByHmac(
  db: Queryable,
  hetuHmac: string,
): Promise<Identity | null> {
  const { rows } = await db.query<Row>("SELECT * FROM identity WHERE hetu_hmac = $1", [hetuHmac]);
  return rows[0] ? identityFrom(rows[0]) : null;
}

export async function findLiveAccount(db: Queryable, identityId: string): Promise<Account | null> {
  const { rows } = await db.query<Row>(
    "SELECT * FROM account WHERE identity_id = $1 AND state <> 'deleted'",
    [identityId],
  );
  return rows[0] ? accountFrom(rows[0]) : null;
}

/**
 * Null when the row exists already: two first logins of the same person can
 * race here (two devices), and the loser must go through the decision again
 * rather than surface the unique violation.
 */
export async function insertIdentity(
  db: Queryable,
  input: { hetuHmac: string } & BrokerReference,
): Promise<Identity | null> {
  const { rows } = await db.query<Row>(
    `INSERT INTO identity (hetu_hmac, broker_subject, broker_session_index, broker_token_id, authenticated_at, acr, amr)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (hetu_hmac) DO NOTHING RETURNING *`,
    [
      input.hetuHmac,
      input.brokerSubject,
      input.brokerSessionIndex,
      input.brokerTokenId,
      input.authenticatedAt,
      input.acr,
      input.amr,
    ],
  );
  const row = rows[0];
  return row ? identityFrom(row) : null;
}

/** Every login refreshes the broker's reference: the latest event is the one a request would concern. */
export async function updateBrokerReference(
  db: Queryable,
  identityId: string,
  ref: BrokerReference,
): Promise<void> {
  await db.query(
    `UPDATE identity SET broker_subject = $2, broker_session_index = $3, broker_token_id = $4,
       authenticated_at = $5, acr = $6, amr = $7 WHERE id = $1`,
    [
      identityId,
      ref.brokerSubject,
      ref.brokerSessionIndex,
      ref.brokerTokenId,
      ref.authenticatedAt,
      ref.acr,
      ref.amr,
    ],
  );
}

export async function countRefusedAttempt(db: Queryable, identityId: string): Promise<void> {
  await db.query("UPDATE identity SET refused_attempts = refused_attempts + 1 WHERE id = $1", [
    identityId,
  ]);
}

export async function insertAccount(
  db: Queryable,
  input: { identityId: string; birthYear: number; birthMonth: number },
): Promise<Account> {
  const { rows } = await db.query<Row>(
    `INSERT INTO account (identity_id, state, birth_year, birth_month)
     VALUES ($1, 'registered', $2, $3) RETURNING *`,
    [input.identityId, input.birthYear, input.birthMonth],
  );
  const row = rows[0];
  if (!row) throw new Error("account insert returned no row");
  return accountFrom(row);
}

// Sessions (#35). Every read is keyed by a token hash or by (session id,
// account id): a session is only ever read as the caller's own.

export type SessionRow = {
  id: string;
  accountId: string;
  platform: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

const sessionFrom = (r: Row): SessionRow => ({
  id: r.id as string,
  accountId: r.account_id as string,
  platform: r.platform as string,
  createdAt: r.created_at as Date,
  expiresAt: r.expires_at as Date,
  revokedAt: (r.revoked_at as Date | null) ?? null,
});

const SESSION_COLUMNS = "id, account_id, platform, created_at, expires_at, revoked_at";

/** Null when the account is no longer live: a login that outlived the erasure gets no session (#51). */
export async function insertSession(
  db: Queryable,
  input: {
    accountId: string;
    platform: string;
    userAgent: string | null;
    accessHash: string;
    accessExpiresAt: Date;
    refreshHash: string;
    expiresAt: Date;
    at: Date;
  },
): Promise<SessionRow | null> {
  const { rows } = await db.query<Row>(
    `INSERT INTO session (account_id, platform, user_agent, access_hash, access_expires_at, refresh_hash, expires_at, created_at, last_used_at)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $8
     WHERE EXISTS (SELECT 1 FROM account WHERE id = $1 AND state <> 'deleted')
     RETURNING ${SESSION_COLUMNS}`,
    [
      input.accountId,
      input.platform,
      input.userAgent,
      input.accessHash,
      input.accessExpiresAt,
      input.refreshHash,
      input.expiresAt,
      input.at,
    ],
  );
  return rows[0] ? sessionFrom(rows[0]) : null;
}

/** The middleware's lookup: the session with the account's state, by the access token's hash. */
export async function findSessionByAccessHash(
  db: Queryable,
  accessHash: string,
): Promise<{
  accountId: string;
  sessionId: string;
  accessExpiresAt: Date;
  revokedAt: Date | null;
  accountState: string;
  identityStanding: string;
} | null> {
  const { rows } = await db.query<Row>(
    `SELECT s.id, s.account_id, s.access_expires_at, s.revoked_at, s.expires_at, a.state, i.standing
     FROM session s JOIN account a ON a.id = s.account_id JOIN identity i ON i.id = a.identity_id
     WHERE s.access_hash = $1`,
    [accessHash],
  );
  const r = rows[0];
  if (!r) return null;
  const expiresAt = r.expires_at as Date;
  const revokedAt = (r.revoked_at as Date | null) ?? null;
  return {
    accountId: r.account_id as string,
    sessionId: r.id as string,
    // A refresh token past its life ends the session as a revocation would.
    accessExpiresAt: new Date(
      Math.min((r.access_expires_at as Date).getTime(), expiresAt.getTime()),
    ),
    revokedAt,
    accountState: r.state as string,
    identityStanding: r.standing as string,
  };
}

/**
 * The states in which a session answers. A sanction is set on the identity
 * (rules/api.md) and an account may be suspended, banned or erased on its own;
 * any of them ends every session, for the access token and the refresh token
 * alike, and the same clause serves both paths.
 */
export const LIVE_ACCOUNT_STATES = ["registered", "active", "paused", "shadow_banned"] as const;
const SESSION_ALIVE = `EXISTS (
  SELECT 1 FROM account a JOIN identity i ON i.id = a.identity_id
  WHERE a.id = session.account_id AND i.standing = 'ok'
    AND a.state IN ('registered', 'active', 'paused', 'shadow_banned'))`;

export async function touchSession(db: Queryable, sessionId: string, at: Date): Promise<void> {
  await db.query("UPDATE session SET last_used_at = $2 WHERE id = $1 AND last_used_at < $2", [
    sessionId,
    at,
  ]);
}

/**
 * Rotates in place when the presented hash is the live one; null when it is
 * not. Only the hash retired by the last rotation is kept: a token two
 * rotations old reads as unknown, which is narrower than the reuse rule but
 * costs nothing, since nobody could have used that token in between.
 */
export async function rotateSession(
  db: Queryable,
  input: {
    refreshHash: string;
    nextAccessHash: string;
    nextAccessExpiresAt: Date;
    nextRefreshHash: string;
    at: Date;
  },
): Promise<SessionRow | null> {
  const { rows } = await db.query<Row>(
    `UPDATE session
     SET refresh_hash = $2, retired_refresh_hash = $1, access_hash = $3, access_expires_at = $4, last_used_at = $5
     WHERE refresh_hash = $1 AND revoked_at IS NULL AND expires_at > $5 AND ${SESSION_ALIVE}
     RETURNING ${SESSION_COLUMNS}`,
    [
      input.refreshHash,
      input.nextRefreshHash,
      input.nextAccessHash,
      input.nextAccessExpiresAt,
      input.at,
    ],
  );
  return rows[0] ? sessionFrom(rows[0]) : null;
}

export async function findSessionByRetiredRefreshHash(
  db: Queryable,
  retiredRefreshHash: string,
): Promise<SessionRow | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${SESSION_COLUMNS} FROM session WHERE retired_refresh_hash = $1`,
    [retiredRefreshHash],
  );
  return rows[0] ? sessionFrom(rows[0]) : null;
}

export async function findSessionForAccount(
  db: Queryable,
  sessionId: string,
  accountId: string,
): Promise<SessionRow | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${SESSION_COLUMNS} FROM session WHERE id = $1 AND account_id = $2`,
    [sessionId, accountId],
  );
  return rows[0] ? sessionFrom(rows[0]) : null;
}

export async function revokeSession(
  db: Queryable,
  sessionId: string,
  at: Date,
  reason: string,
): Promise<void> {
  await db.query(
    "UPDATE session SET revoked_at = $2, revoked_reason = $3 WHERE id = $1 AND revoked_at IS NULL",
    [sessionId, at, reason],
  );
}

export async function revokeAccountSessions(
  db: Queryable,
  accountId: string,
  at: Date,
  reason: string,
): Promise<number> {
  const result = await db.query(
    "UPDATE session SET revoked_at = $2, revoked_reason = $3 WHERE account_id = $1 AND revoked_at IS NULL",
    [accountId, at, reason],
  );
  return result.rowCount ?? 0;
}

/** Ended before `endedBefore`, whose refresh token expired, or whose account is erased (#51): gone. */
export async function deleteDeadSessions(
  db: Queryable,
  endedBefore: Date,
  now: Date,
): Promise<number> {
  const result = await db.query(
    `DELETE FROM session WHERE (revoked_at IS NOT NULL AND revoked_at < $1) OR expires_at < $2
       OR account_id IN (SELECT id FROM account WHERE state = 'deleted')`,
    [endedBefore, now],
  );
  return result.rowCount ?? 0;
}

export async function deleteExpiredAuthRequests(db: Queryable, now: Date): Promise<number> {
  const result = await db.query(
    "DELETE FROM auth_request WHERE expires_at < $1 AND (code_expires_at IS NULL OR code_expires_at < $1)",
    [now],
  );
  return result.rowCount ?? 0;
}

// Staff (#49, rules/admin.md): a role on the identity row is the allowlist;
// an admin session is its own table, eight hours, no refresh, hashed token.

export async function findModeratorRole(
  db: Queryable,
  identityId: string,
): Promise<ModeratorRole | null> {
  const { rows } = await db.query<{ role: ModeratorRole }>(
    "SELECT role FROM moderator_roles WHERE identity_id = $1",
    [identityId],
  );
  return rows[0]?.role ?? null;
}

/** An admin login's one-time code resolves to an identity, never to an account. */
export async function attachAdminCode(
  db: Queryable,
  input: { id: string; codeHash: string; codeExpiresAt: Date; identityId: string },
): Promise<void> {
  await db.query(
    `UPDATE auth_request SET code_hash = $2, code_expires_at = $3, identity_id = $4, outcome = 'admin'
     WHERE id = $1`,
    [input.id, input.codeHash, input.codeExpiresAt, input.identityId],
  );
}

export type AdminSessionRow = {
  id: string;
  identityId: string;
  role: ModeratorRole;
  expiresAt: Date;
  revokedAt: Date | null;
};

const adminSessionFrom = (r: Row): AdminSessionRow => ({
  id: r.id as string,
  identityId: r.identity_id as string,
  role: r.role as ModeratorRole,
  expiresAt: r.expires_at as Date,
  revokedAt: (r.revoked_at as Date | null) ?? null,
});

export async function insertAdminSession(
  db: Queryable,
  input: { identityId: string; role: ModeratorRole; accessHash: string; expiresAt: Date; at: Date },
): Promise<AdminSessionRow> {
  const { rows } = await db.query<Row>(
    `INSERT INTO admin_session (identity_id, role, access_hash, expires_at, created_at, last_used_at)
     VALUES ($1, $2, $3, $4, $5, $5) RETURNING id, identity_id, role, expires_at, revoked_at`,
    [input.identityId, input.role, input.accessHash, input.expiresAt, input.at],
  );
  const row = rows[0];
  if (!row) throw new Error("admin_session insert returned no row");
  return adminSessionFrom(row);
}

/** The admin guard's lookup: the session with the identity's standing and its current role. */
export async function findAdminSessionByAccessHash(
  db: Queryable,
  accessHash: string,
): Promise<
  (AdminSessionRow & { identityStanding: string; currentRole: ModeratorRole | null }) | null
> {
  const { rows } = await db.query<Row>(
    `SELECT s.id, s.identity_id, s.role, s.expires_at, s.revoked_at, i.standing, m.role AS current_role
     FROM admin_session s JOIN identity i ON i.id = s.identity_id
     LEFT JOIN moderator_roles m ON m.identity_id = s.identity_id
     WHERE s.access_hash = $1`,
    [accessHash],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    ...adminSessionFrom(r),
    identityStanding: r.standing as string,
    currentRole: (r.current_role as ModeratorRole | null) ?? null,
  };
}

export async function touchAdminSession(db: Queryable, id: string, at: Date): Promise<void> {
  await db.query("UPDATE admin_session SET last_used_at = $2 WHERE id = $1 AND last_used_at < $2", [
    id,
    at,
  ]);
}

export async function revokeAdminSession(db: Queryable, id: string, at: Date): Promise<void> {
  await db.query("UPDATE admin_session SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL", [
    id,
    at,
  ]);
}

/** Expired or ended admin sessions: gone with the nightly sweep. */
export async function deleteDeadAdminSessions(db: Queryable, now: Date): Promise<number> {
  const result = await db.query(
    "DELETE FROM admin_session WHERE expires_at < $1 OR revoked_at IS NOT NULL",
    [now],
  );
  return result.rowCount ?? 0;
}

// Erasure and export (#51, TD-7). Every statement is keyed by the caller's
// account id; the identity is reached through its account only.

export async function findAccountById(db: Queryable, accountId: string): Promise<Account | null> {
  const { rows } = await db.query<Row>("SELECT * FROM account WHERE id = $1", [accountId]);
  return rows[0] ? accountFrom(rows[0]) : null;
}

/** What the export says about the person's identity row: dates and the login level, never the hash. */
export async function findIdentitySummaryForAccount(
  db: Queryable,
  accountId: string,
): Promise<{
  identityId: string;
  createdAt: Date;
  authenticatedAt: Date | null;
  acr: string | null;
  deletionCount: number;
} | null> {
  const { rows } = await db.query<Row>(
    `SELECT i.id, i.created_at, i.authenticated_at, i.acr, i.deletion_count
     FROM identity i JOIN account a ON a.identity_id = i.id WHERE a.id = $1`,
    [accountId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    identityId: r.id as string,
    createdAt: r.created_at as Date,
    authenticatedAt: (r.authenticated_at as Date | null) ?? null,
    acr: (r.acr as string | null) ?? null,
    deletionCount: r.deletion_count as number,
  };
}

export async function listSessionsForAccount(
  db: Queryable,
  accountId: string,
): Promise<Array<SessionRow & { lastUsedAt: Date }>> {
  const { rows } = await db.query<Row>(
    `SELECT ${SESSION_COLUMNS}, last_used_at FROM session
     WHERE account_id = $1 AND revoked_at IS NULL ORDER BY created_at`,
    [accountId],
  );
  return rows.map((r) => ({ ...sessionFrom(r), lastUsedAt: r.last_used_at as Date }));
}

/** Every session of the account, gone (not revoked and kept: erasure). */
export async function deleteAccountSessions(db: Queryable, accountId: string): Promise<number> {
  const result = await db.query("DELETE FROM session WHERE account_id = $1", [accountId]);
  return result.rowCount ?? 0;
}

export async function deleteAuthRequestsOfAccount(
  db: Queryable,
  accountId: string,
): Promise<number> {
  const result = await db.query("DELETE FROM auth_request WHERE account_id = $1", [accountId]);
  return result.rowCount ?? 0;
}

/**
 * The account row stays as an anonymised tombstone (#34, #51): state deleted,
 * the age gone, the dates kept. The partial unique index then admits a new
 * live account for the identity once the cooldown has passed.
 */
export async function tombstoneAccount(
  db: Queryable,
  accountId: string,
  at: Date,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE account SET state = 'deleted', state_changed_at = $2, deleted_at = $2,
       birth_year = NULL, birth_month = NULL, gender = NULL, pond_id = NULL,
       gender_changed_at = NULL, seeks_changed_at = NULL, email = NULL
     WHERE id = $1 AND state <> 'deleted'`,
    [accountId, at],
  );
  return result.rowCount === 1;
}

export async function recordIdentityDeletion(
  db: Queryable,
  identityId: string,
  input: { deletionCount: number; reregisterAfter: Date },
): Promise<void> {
  await db.query("UPDATE identity SET deletion_count = $2, reregister_after = $3 WHERE id = $1", [
    identityId,
    input.deletionCount,
    input.reregisterAfter,
  ]);
}

/**
 * The account row under lock for the erasure transaction (#47 review): a
 * writer of per-account rows that takes the same lock either finishes before
 * the deletes or sees the tombstone and writes nothing, so no row can slip in
 * behind the erasure. The state comes back so the caller can refuse a
 * tombstone before deleting anything.
 */
export async function lockAccountForErasure(
  db: Queryable,
  accountId: string,
): Promise<{ state: string } | null> {
  const { rows } = await db.query<{ state: string }>(
    "SELECT state FROM account WHERE id = $1 FOR UPDATE",
    [accountId],
  );
  return rows[0] ?? null;
}

// Onboarding and consents (#46, ADR-010). Every statement carries the
// caller's account id (rule 6); a consent row is never rewritten, only
// withdrawn, because it is the proof of what was agreed.

/** Sets the gender; `changedAt` is the time of a change from an earlier answer (#147), null when it is none. */
export async function setGender(
  db: Queryable,
  accountId: string,
  gender: string,
  changedAt: Date | null,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE account SET gender = $2, gender_changed_at = COALESCE($3, gender_changed_at)
     WHERE id = $1 AND state <> 'deleted'`,
    [accountId, gender, changedAt],
  );
  return result.rowCount === 1;
}

/** The gender as declared so far, and when it last changed, under the lock erasure takes first; undefined for no live account. */
export async function lockGender(
  db: Queryable,
  accountId: string,
): Promise<{ gender: string | null; changedAt: Date | null } | undefined> {
  const { rows } = await db.query<{ gender: string | null; gender_changed_at: Date | null }>(
    "SELECT gender, gender_changed_at FROM account WHERE id = $1 AND state <> 'deleted' FOR UPDATE",
    [accountId],
  );
  const row = rows[0];
  return row ? { gender: row.gender, changedAt: row.gender_changed_at ?? null } : undefined;
}

/**
 * The optional e-mail (#148, TD-18), set or cleared; a tombstone takes none.
 * The value is in the statement and nowhere else: not in the log line the
 * caller writes, not in an event (rules/api.md).
 */
export async function setEmail(
  db: Queryable,
  accountId: string,
  email: string | null,
): Promise<boolean> {
  const result = await db.query(
    "UPDATE account SET email = $2 WHERE id = $1 AND state <> 'deleted'",
    [accountId, email],
  );
  return result.rowCount === 1;
}

/** registered becomes active once (the onboarding rule decides when); nothing else changes here. */
export async function activateAccount(
  db: Queryable,
  accountId: string,
  at: Date,
): Promise<boolean> {
  const result = await db.query(
    "UPDATE account SET state = 'active', state_changed_at = $2 WHERE id = $1 AND state = 'registered'",
    [accountId, at],
  );
  return result.rowCount === 1;
}

export type ConsentRow = {
  kind: string;
  version: string;
  locale: string;
  givenAt: Date;
  withdrawnAt: Date | null;
};

/** What GET /consents lists: the newest hundred, oldest first. The export and the status read past that. */
export const CONSENTS_LISTED = 100;

const consentFrom = (r: Row): ConsentRow => ({
  kind: r.kind as string,
  version: r.version as string,
  locale: r.locale_shown as string,
  givenAt: r.given_at as Date,
  withdrawnAt: (r.withdrawn_at as Date | null) ?? null,
});

/** Every consent row of the account, oldest first; `limit` keeps the newest that many (the list route). */
export async function listConsents(
  db: Queryable,
  accountId: string,
  limit?: number,
): Promise<ConsentRow[]> {
  const { rows } =
    limit === undefined
      ? await db.query<Row>(
          `SELECT kind, version, locale_shown, given_at, withdrawn_at FROM consent
           WHERE account_id = $1 ORDER BY given_at, kind`,
          [accountId],
        )
      : await db.query<Row>(
          `SELECT kind, version, locale_shown, given_at, withdrawn_at FROM (
             SELECT kind, version, locale_shown, given_at, withdrawn_at FROM consent
             WHERE account_id = $1 ORDER BY given_at DESC LIMIT $2) newest
           ORDER BY given_at, kind`,
          [accountId, limit],
        );
  return rows.map(consentFrom);
}

/** The newest active row per kind: what the status and the activation rule look at, however long the history. */
export async function activeConsents(db: Queryable, accountId: string): Promise<ConsentRow[]> {
  const { rows } = await db.query<Row>(
    `SELECT DISTINCT ON (kind) kind, version, locale_shown, given_at, withdrawn_at FROM consent
     WHERE account_id = $1 AND withdrawn_at IS NULL ORDER BY kind, given_at DESC`,
    [accountId],
  );
  return rows.map(consentFrom);
}

/**
 * One row per consent given: the same kind and version, still active, is
 * not written twice; a withdrawn research consent given again is a new row.
 * A tombstone takes none (#51).
 */
/** Research consents given within a day before the next is refused: the rows are kept for good, so churn is capped. */
export const CONSENT_CHURN_PER_DAY = 10;

export async function recordConsent(
  db: Queryable,
  accountId: string,
  input: { kind: string; version: string; locale: string },
  at: Date,
): Promise<"recorded" | "already" | "no_account" | "too_many"> {
  return transaction(db, async (tx) => {
    // The lock erasure takes first (ADR-009 §8), so no consent row lands behind the deletes.
    const live = await tx.query(
      "SELECT 1 FROM account WHERE id = $1 AND state <> 'deleted' FOR UPDATE",
      [accountId],
    );
    if (live.rows.length === 0) return "no_account";
    const recent = await tx.query<{ n: string }>(
      `SELECT count(*) AS n FROM consent
       WHERE account_id = $1 AND kind = $2 AND given_at > $3::timestamptz - interval '1 day'`,
      [accountId, input.kind, at],
    );
    if (Number(recent.rows[0]?.n ?? 0) >= CONSENT_CHURN_PER_DAY) return "too_many";
    const result = await tx.query(
      `INSERT INTO consent (account_id, kind, version, locale_shown, given_at)
       SELECT $1, $2, $3, $4, $5
       WHERE NOT EXISTS (SELECT 1 FROM consent
                         WHERE account_id = $1 AND kind = $2 AND version = $3 AND withdrawn_at IS NULL)`,
      [accountId, input.kind, input.version, input.locale, at],
    );
    return result.rowCount === 1 ? "recorded" : "already";
  });
}

/** Marks every active consent of the kind withdrawn; the rows stay. Under the account row's lock like every writer (ADR-010 §8). */
export async function withdrawConsent(
  db: Queryable,
  accountId: string,
  kind: string,
  at: Date,
): Promise<{ live: boolean; withdrawn: number }> {
  return transaction(db, async (tx) => {
    const live = await tx.query(
      "SELECT 1 FROM account WHERE id = $1 AND state <> 'deleted' FOR UPDATE",
      [accountId],
    );
    if (live.rows.length === 0) return { live: false, withdrawn: 0 };
    const result = await tx.query(
      "UPDATE consent SET withdrawn_at = $3 WHERE account_id = $1 AND kind = $2 AND withdrawn_at IS NULL",
      [accountId, kind, at],
    );
    return { live: true, withdrawn: result.rowCount ?? 0 };
  });
}
