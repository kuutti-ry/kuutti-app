import {
  type Account,
  type AuthRequest,
  type Identity,
  type Queryable,
  transaction,
} from "@kuutti/db";
import type { IdentityStanding, ModeratorRole } from "@kuutti/schema";
import type { SessionStanding } from "../lib/auth-middleware.ts";

// Raw parameterised SQL rather than the Drizzle builder (rules/api.md asks for
// a reason): `Deps.db` is the `Queryable` seam through which the test harness
// hands in one rolled-back transaction per test, and Drizzle's node-postgres
// driver wants a Pool or Client, not that seam. Every statement here is keyed
// by a primary or unique key; none reads user data by anything a request
// controls except the state and the code hash, which are the keys of the
// login attempt itself. The code challenge, also request-controlled, only
// narrows the lookup by the code hash (ADR-027).

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
  suspensionEndsAt: (r.suspension_ends_at as Date | null) ?? null,
  createdAt: r.created_at as Date,
});

const accountFrom = (r: Row): Account => ({
  id: r.id as string,
  identityId: r.identity_id as string,
  state: r.state as Account["state"],
  stateChangedAt: (r.state_changed_at as Date | null) ?? null,
  pausedFrom: (r.paused_from as Account["pausedFrom"]) ?? null,
  sanctionedFrom: (r.sanctioned_from as Account["sanctionedFrom"]) ?? null,
  birthYear: (r.birth_year as number | null) ?? null,
  birthMonth: (r.birth_month as number | null) ?? null,
  gender: (r.gender as Account["gender"]) ?? null,
  pondId: (r.pond_id as string | null) ?? null,
  genderChangedAt: (r.gender_changed_at as Date | null) ?? null,
  email: (r.email as string | null) ?? null,
  foundThemAnswered: r.found_them_answered === true,
  emailConfirmedAt: (r.email_confirmed_at as Date | null) ?? null,
  registeredAt: r.registered_at as Date,
  deletedAt: (r.deleted_at as Date | null) ?? null,
});

const authRequestFrom = (r: Row): AuthRequest => ({
  id: r.id as string,
  state: r.state as string,
  nonce: r.nonce as string,
  platform: r.platform as string,
  locale: (r.locale as string | null) ?? null,
  codeChallenge: (r.code_challenge as string | null) ?? null,
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

type NewAuthRequest = {
  state: string;
  nonce: string;
  platform: string;
  locale: string | null;
  expiresAt: Date;
  /** SHA-256 hex of the app's verifier (ADR-027); null only on a staff attempt. */
  codeChallenge: string | null;
};

/**
 * Inserts the attempt only while the table holds fewer than `cap` rows, the
 * count and the insert in one statement (ADR-026 §6); false when it was full.
 * Concurrent starts can each see room, so the table may overshoot the cap by
 * at most the connection pool's size; the starts at the ceiling take the
 * excess back, one row each.
 */
export async function insertAuthRequest(
  db: Queryable,
  input: NewAuthRequest,
  cap: number,
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO auth_request (state, nonce, platform, locale, expires_at, code_challenge)
     SELECT $1::text, $2::text, $3::text, $4::text, $5::timestamptz, $6::text
     WHERE (SELECT count(*) FROM auth_request) < $7`,
    [
      input.state,
      input.nonce,
      input.platform,
      input.locale,
      input.expiresAt,
      input.codeChallenge,
      cap,
    ],
  );
  return result.rowCount === 1;
}

/**
 * The start at the ceiling (ADR-026 §6): deletes the two oldest attempts the
 * bank has not answered yet and inserts this one, in one statement and with
 * no count, so no other start can take the room in between and the cost is a
 * walk of the expiry index and two deletes by primary key. Two rather than
 * one, so a table that concurrent starts left past the ceiling drains back
 * under it. An attempt the bank has answered, holding a code or claimed by
 * its callback (ADR-026 §8), is never taken: its person has been to the bank
 * and is on the way back. Rows another start is deleting or a callback is
 * claiming are skipped rather than waited for. Returns how many were deleted;
 * 0 means there was no unanswered attempt to take, and nothing was inserted.
 */
export async function evictAndInsertAuthRequest(
  db: Queryable,
  input: NewAuthRequest,
): Promise<number> {
  const { rows } = await db.query<{ evicted: number }>(
    `WITH gone AS (
       DELETE FROM auth_request WHERE id = ANY(ARRAY(
         SELECT id FROM auth_request WHERE code_hash IS NULL AND outcome IS NULL
         ORDER BY expires_at LIMIT 2 FOR UPDATE SKIP LOCKED))
       RETURNING id)
     INSERT INTO auth_request (state, nonce, platform, locale, expires_at, code_challenge)
     SELECT $1::text, $2::text, $3::text, $4::text, $5::timestamptz, $6::text
     WHERE EXISTS (SELECT 1 FROM gone)
     RETURNING (SELECT count(*) FROM gone)::int AS evicted`,
    [input.state, input.nonce, input.platform, input.locale, input.expiresAt, input.codeChallenge],
  );
  return rows[0]?.evicted ?? 0;
}

/**
 * The callback's first statement (#324, ADR-026 §8): finds the attempt by its
 * state and spends it in the same statement, before the broker is asked
 * anything, so a second return with that state, at once or later, finds
 * nothing and costs no token call. Two returns at once: the second waits on
 * the row's lock and then reads the mark. The mark is `outcome = 'answered'`,
 * which the eviction skips, and the expiry moves to `until`, so neither the
 * eviction nor the sweep of expired rows ends an attempt under way; the
 * attach replaces the mark with what the login decided. Null when the state
 * is unknown, already answered, holds a code or has expired at `now`.
 */
export async function claimAuthRequest(
  db: Queryable,
  input: { state: string; now: Date; until: Date },
): Promise<AuthRequest | null> {
  const { rows } = await db.query<Row>(
    `UPDATE auth_request SET outcome = 'answered', expires_at = $3
     WHERE state = $1 AND outcome IS NULL AND code_hash IS NULL AND expires_at > $2
     RETURNING *`,
    [input.state, input.now, input.until],
  );
  return rows[0] ? authRequestFrom(rows[0]) : null;
}

/**
 * The platform of the attempt with this state, whatever its mark or expiry:
 * where the browser of a callback the claim refused belongs, so a staff
 * attempt's replay goes back to the panel (#250, ADR-026 §8). Null when no
 * row holds the state, never written, evicted or swept.
 */
export async function findAuthRequestPlatform(
  db: Queryable,
  state: string,
): Promise<string | null> {
  const { rows } = await db.query<{ platform: string }>(
    "SELECT platform FROM auth_request WHERE state = $1",
    [state],
  );
  return rows[0]?.platform ?? null;
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

/**
 * Ends a claimed attempt whose callback was refused or failed (ADR-026 §8):
 * its expiry becomes now, so the row is the sweep's, the first thing the
 * ceiling clears, rather than one the eviction must skip until its deadline.
 * The mark stays, so the state is still refused at a replay.
 */
export async function expireAuthRequest(db: Queryable, id: string, at: Date): Promise<void> {
  await db.query("UPDATE auth_request SET expires_at = $2 WHERE id = $1", [id, at]);
}

/**
 * The app's exchange (ADR-027): finds the code by its hash and spends it in
 * the same statement, only with the challenge its attempt was started with,
 * within its minute, and only for an account's code. An unknown, used,
 * expired or staff code and a wrong verifier alike find nothing, and a wrong
 * verifier leaves the code unspent. Two exchanges at once: the second waits
 * on the row's lock and then reads the mark.
 */
export async function consumeAppCode(
  db: Queryable,
  input: { codeHash: string; codeChallenge: string; at: Date },
): Promise<{ accountId: string; platform: string; outcome: string | null } | null> {
  const { rows } = await db.query<{
    account_id: string;
    platform: string;
    outcome: string | null;
  }>(
    `UPDATE auth_request SET code_used_at = $3
     WHERE code_hash = $1 AND code_challenge = $2 AND account_id IS NOT NULL
       AND code_used_at IS NULL AND code_expires_at >= $3
     RETURNING account_id, platform, outcome`,
    [input.codeHash, input.codeChallenge, input.at],
  );
  const row = rows[0];
  return row ? { accountId: row.account_id, platform: row.platform, outcome: row.outcome } : null;
}

/** The staff exchange's spend; the row count says whether this call was the first to. */
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

/**
 * Null when the identity has a live account already: two logins of the same
 * person can both decide to create one (two devices), and the loser must go
 * through the decision again, where it resumes the winner's, rather than
 * surface the unique violation of `account_one_live_per_identity_idx`.
 */
export async function insertAccount(
  db: Queryable,
  input: { identityId: string; birthYear: number; birthMonth: number },
): Promise<Account | null> {
  const { rows } = await db.query<Row>(
    `INSERT INTO account (identity_id, state, birth_year, birth_month)
     VALUES ($1, 'registered', $2, $3)
     ON CONFLICT (identity_id) WHERE state <> 'deleted' DO NOTHING RETURNING *`,
    [input.identityId, input.birthYear, input.birthMonth],
  );
  const row = rows[0];
  return row ? accountFrom(row) : null;
}

// Sessions (#35). Every read is keyed by a token hash or by (session id,
// account id): a session is only ever read as the caller's own.

export type SessionRow = {
  id: string;
  accountId: string;
  platform: string;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

const sessionFrom = (r: Row): SessionRow => ({
  id: r.id as string,
  accountId: r.account_id as string,
  platform: r.platform as string,
  userAgent: (r.user_agent as string | null) ?? null,
  createdAt: r.created_at as Date,
  expiresAt: r.expires_at as Date,
  revokedAt: (r.revoked_at as Date | null) ?? null,
});

const SESSION_COLUMNS = "id, account_id, platform, user_agent, created_at, expires_at, revoked_at";

/**
 * Null when the account is no longer live: a login that outlived the erasure
 * gets no session (#51), and neither does one that a sanction or a break
 * overtook (ADR-024 §4). The guard's own rule, under the account row's share
 * lock: a sanction committing first is seen here, and one committing after
 * waits for this insert and revokes it.
 */
export async function insertSession(
  db: Queryable,
  input: {
    accountId: string;
    platform: string;
    userAgent: string | null;
    accessHash: string;
    accessExpiresAt: Date;
    refreshHash: string;
    familyHash: string;
    expiresAt: Date;
    at: Date;
  },
): Promise<SessionRow | null> {
  const { rows } = await db.query<Row>(
    `INSERT INTO session (account_id, platform, user_agent, access_hash, access_expires_at, refresh_hash, family_hash, expires_at, created_at, last_used_at)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $9
     WHERE EXISTS (
       SELECT 1 FROM account a JOIN identity i ON i.id = a.identity_id
       WHERE a.id = $1 AND i.standing = 'ok'
         AND a.state IN ('registered', 'active', 'paused', 'shadow_banned')
       FOR SHARE OF a)
     RETURNING ${SESSION_COLUMNS}`,
    [
      input.accountId,
      input.platform,
      input.userAgent,
      input.accessHash,
      input.accessExpiresAt,
      input.refreshHash,
      input.familyHash,
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
const SESSION_ALIVE = `EXISTS (
  SELECT 1 FROM account a JOIN identity i ON i.id = a.identity_id
  WHERE a.id = session.account_id AND i.standing = 'ok'
    AND a.state IN ('registered', 'active', 'paused', 'shadow_banned'))`;

/**
 * How a session stands for an open socket (#349), by the session's id, which
 * a refresh keeps, never by the access hash, which it rotates: `ended` when
 * the row is gone (erasure deletes it), revoked, or the account or identity
 * is no longer in a live state; `expired` when its access token, or the
 * session itself, is past its time, as the session guard reads it: the
 * instant itself still live. A shadow ban leaves the session live
 * (ADR-024 §6), so the socket reads it here to hide the account. Scoped by
 * the account (rule 6).
 */
export async function sessionStanding(
  db: Queryable,
  input: { sessionId: string; accountId: string; at: Date },
): Promise<SessionStanding> {
  const { rows } = await db.query<{ expired: boolean; shadow_banned: boolean }>(
    `SELECT (session.access_expires_at < $3 OR session.expires_at < $3) AS expired,
       a.state = 'shadow_banned' AS shadow_banned
     FROM session JOIN account a ON a.id = session.account_id
     WHERE session.id = $1 AND session.account_id = $2 AND session.revoked_at IS NULL
       AND ${SESSION_ALIVE}`,
    [input.sessionId, input.accountId, input.at],
  );
  const row = rows[0];
  if (!row) return { standing: "ended", shadowBanned: false };
  return { standing: row.expired ? "expired" : "live", shadowBanned: row.shadow_banned };
}

export async function touchSession(db: Queryable, sessionId: string, at: Date): Promise<void> {
  await db.query("UPDATE session SET last_used_at = $2 WHERE id = $1 AND last_used_at < $2", [
    sessionId,
    at,
  ]);
}

/**
 * Rotates in place when the presented hash is the live one; null when it is
 * not, and then `findSessionByFamilyHash` tells a retired token of the session
 * from an unknown one (ADR-059).
 *
 * The end moves to `nextExpiresAt`, never past `ceilingMs` after the row's
 * creation, the bank login (ADR-058); once it is reached, the next refresh
 * finds the end passed.
 */
export async function rotateSession(
  db: Queryable,
  input: {
    refreshHash: string;
    nextAccessHash: string;
    nextAccessExpiresAt: Date;
    nextRefreshHash: string;
    nextExpiresAt: Date;
    ceilingMs: number;
    at: Date;
  },
): Promise<SessionRow | null> {
  const { rows } = await db.query<Row>(
    `UPDATE session
     SET refresh_hash = $2, access_hash = $3, access_expires_at = $4, last_used_at = $5,
       expires_at = LEAST($6::timestamptz, created_at + $7::double precision * interval '1 millisecond')
     WHERE refresh_hash = $1 AND revoked_at IS NULL AND expires_at > $5 AND ${SESSION_ALIVE}
     RETURNING ${SESSION_COLUMNS}`,
    [
      input.refreshHash,
      input.nextRefreshHash,
      input.nextAccessHash,
      input.nextAccessExpiresAt,
      input.at,
      input.nextExpiresAt,
      input.ceilingMs,
    ],
  );
  return rows[0] ? sessionFrom(rows[0]) : null;
}

/**
 * The session a refresh token belongs to, by the hash of its family part, the
 * secret the session keeps for its life (ADR-059); `live` when the presented
 * token is the session's live one, so a session that ended by itself is told
 * from a retired token coming back.
 */
export async function findSessionByFamilyHash(
  db: Queryable,
  input: { familyHash: string; refreshHash: string },
): Promise<(SessionRow & { live: boolean }) | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${SESSION_COLUMNS}, refresh_hash = $2 AS live FROM session WHERE family_hash = $1`,
    [input.familyHash, input.refreshHash],
  );
  const row = rows[0];
  return row ? { ...sessionFrom(row), live: row.live as boolean } : null;
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

/**
 * An admin login's one-time code resolves to an identity, never to an
 * account. The callback has claimed the attempt (ADR-026 §8), so neither the
 * eviction nor the sweep can have ended it, and no row count is asked for.
 */
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

/**
 * A panel session, only for an identity in good standing, under the identity
 * row's share lock (ADR-024 §4): a sanction committing first is seen here,
 * and one committing after waits for this insert and revokes it, so a login
 * that raced a suspension leaves nothing a lift would revive. Null otherwise.
 */
export async function insertAdminSession(
  db: Queryable,
  input: { identityId: string; role: ModeratorRole; accessHash: string; expiresAt: Date; at: Date },
): Promise<AdminSessionRow | null> {
  const { rows } = await db.query<Row>(
    `INSERT INTO admin_session (identity_id, role, access_hash, expires_at, created_at, last_used_at)
     SELECT $1, $2, $3, $4, $5, $5
     WHERE EXISTS (SELECT 1 FROM identity WHERE id = $1 AND standing = 'ok' FOR SHARE)
     RETURNING id, identity_id, role, expires_at, revoked_at`,
    [input.identityId, input.role, input.accessHash, input.expiresAt, input.at],
  );
  const row = rows[0];
  return row ? adminSessionFrom(row) : null;
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

/**
 * The nightly sweep: every ended staff session goes, except each current
 * member's newest, which the staff list reads as their last sign-in (#310,
 * ADR-006). Kept expired or revoked, it never authenticates; it goes once a
 * newer session replaces it or the role is taken away.
 */
export async function deleteDeadAdminSessions(db: Queryable, now: Date): Promise<number> {
  const result = await db.query(
    `DELETE FROM admin_session
     WHERE (expires_at < $1 OR revoked_at IS NOT NULL)
       AND id NOT IN (
         SELECT DISTINCT ON (s.identity_id) s.id
         FROM admin_session s JOIN moderator_roles m ON m.identity_id = s.identity_id
         ORDER BY s.identity_id, s.created_at DESC, s.id DESC)`,
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

/** What the export says about the person's identity row: its dates, standing and counters, never the hash. */
export async function findIdentitySummaryForAccount(
  db: Queryable,
  accountId: string,
): Promise<{
  identityId: string;
  createdAt: Date;
  authenticatedAt: Date | null;
  acr: string | null;
  standing: IdentityStanding;
  standingChangedAt: Date | null;
  deletionCount: number;
  refusedAttempts: number;
  reregisterAfter: Date | null;
} | null> {
  const { rows } = await db.query<Row>(
    `SELECT i.id, i.created_at, i.authenticated_at, i.acr, i.standing, i.standing_changed_at,
            i.deletion_count, i.refused_attempts, i.reregister_after
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
    standing: r.standing as IdentityStanding,
    standingChangedAt: (r.standing_changed_at as Date | null) ?? null,
    deletionCount: r.deletion_count as number,
    refusedAttempts: r.refused_attempts as number,
    reregisterAfter: (r.reregister_after as Date | null) ?? null,
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
       gender_changed_at = NULL, email = NULL, email_confirmed_at = NULL,
       paused_from = NULL, sanctioned_from = NULL, found_them_answered = false
     WHERE id = $1 AND state <> 'deleted'`,
    [accountId, at],
  );
  return result.rowCount === 1;
}

/**
 * Taking a break (#170, ADR-022): the state is kept aside and the row is
 * paused. Only a finished account can: a shadow-banned one like an active
 * one, so the ban shows to nobody (ADR-013 §2); `registered` is refused by the
 * row count, since there is nothing to hide yet and the resume would skip the
 * activation rule (ADR-010 §6).
 */
export async function pauseAccount(db: Queryable, accountId: string, at: Date): Promise<boolean> {
  const result = await db.query(
    `UPDATE account SET paused_from = state, state = 'paused', state_changed_at = $2
     WHERE id = $1 AND state IN ('active', 'shadow_banned')`,
    [accountId, at],
  );
  return result.rowCount === 1;
}

/** The login that ends a break: the state kept aside comes back; `active` for a row paused before the column existed. */
export async function resumeAccount(db: Queryable, accountId: string, at: Date): Promise<boolean> {
  const result = await db.query(
    `UPDATE account SET state = COALESCE(paused_from, 'active'), paused_from = NULL, state_changed_at = $2
     WHERE id = $1 AND state = 'paused'`,
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
export async function lockAccountRow(
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
 * A different address is unconfirmed and the code waiting for the old one
 * goes (#385, ADR-043 §2); the same address again changes nothing. The value
 * is in the statement and nowhere else: not in the log line the caller
 * writes, not in an event (rules/api.md). Null when there is no live account.
 */
export async function setEmail(
  db: Queryable,
  accountId: string,
  email: string | null,
): Promise<{ changed: boolean } | null> {
  return transaction(db, async (tx) => {
    const { rows } = await tx.query<{ changed: boolean }>(
      `WITH old AS (SELECT email FROM account WHERE id = $1 AND state <> 'deleted' FOR UPDATE)
       UPDATE account a SET email = $2::text,
         email_confirmed_at = CASE WHEN old.email IS NOT DISTINCT FROM $2::text
                                   THEN a.email_confirmed_at END
       FROM old WHERE a.id = $1
       RETURNING old.email IS DISTINCT FROM $2::text AS changed`,
      [accountId, email],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.changed) await tx.query("DELETE FROM email_code WHERE account_id = $1", [accountId]);
    return { changed: row.changed };
  });
}

/** The address, its confirmation and the code waiting for it (#385). */
export type EmailState = {
  email: string | null;
  confirmedAt: Date | null;
  codeExpiresAt: Date | null;
};

/**
 * The caller's own address and what waits for it (rule 6); undefined for no
 * live account. With `lock`, the account row is held for the transaction:
 * every change to the address, its confirmation and its code takes the same
 * lock first, so a send, a confirmation and a change of address never cross.
 * A read that waited for the lock sees the account's row as the holder left
 * it but the joined code as it was before the wait: decide on the code only
 * after reading it again (`findEmailCode`).
 */
export async function findEmailState(
  db: Queryable,
  accountId: string,
  options: { lock?: boolean } = {},
): Promise<EmailState | undefined> {
  const { rows } = await db.query<{
    email: string | null;
    email_confirmed_at: Date | null;
    expires_at: Date | null;
  }>(
    `SELECT a.email, a.email_confirmed_at, c.expires_at
     FROM account a LEFT JOIN email_code c ON c.account_id = a.id
     WHERE a.id = $1 AND a.state <> 'deleted'${options.lock ? " FOR UPDATE OF a" : ""}`,
    [accountId],
  );
  const row = rows[0];
  if (!row) return undefined;
  return { email: row.email, confirmedAt: row.email_confirmed_at, codeExpiresAt: row.expires_at };
}

/**
 * A new code for the address (ADR-043 §3), under the account's lock
 * (`findEmailState` with `lock`): the sends of earlier days go, the day's are
 * counted, and only under `limit` is a send recorded and the code written over
 * any earlier one, its wrong attempts back at none. Only the code's hash.
 */
export async function recordEmailCode(
  db: Queryable,
  input: {
    accountId: string;
    codeHash: string;
    at: Date;
    expiresAt: Date;
    /** Start of the day's count; sends before it neither count nor stay. */
    since: Date;
    limit: number;
  },
): Promise<{ used: number; recorded: boolean }> {
  await db.query("DELETE FROM email_send WHERE account_id = $1 AND at < $2", [
    input.accountId,
    input.since,
  ]);
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM email_send WHERE account_id = $1",
    [input.accountId],
  );
  const used = rows[0]?.n ?? 0;
  if (used >= input.limit) return { used, recorded: false };
  await db.query("INSERT INTO email_send (account_id, at) VALUES ($1, $2)", [
    input.accountId,
    input.at,
  ]);
  await db.query(
    `INSERT INTO email_code (account_id, code_hash, expires_at, attempts, created_at)
     VALUES ($1, $2, $3, 0, $4)
     ON CONFLICT (account_id) DO UPDATE
       SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0,
           created_at = EXCLUDED.created_at`,
    [input.accountId, input.codeHash, input.expiresAt, input.at],
  );
  return { used, recorded: true };
}

/** The code waiting for the caller's address, as stored: its hash, its end and its wrong attempts. */
export async function findEmailCode(
  db: Queryable,
  accountId: string,
): Promise<{ codeHash: string; expiresAt: Date; attempts: number } | undefined> {
  const { rows } = await db.query<{ code_hash: string; expires_at: Date; attempts: number }>(
    "SELECT code_hash, expires_at, attempts FROM email_code WHERE account_id = $1",
    [accountId],
  );
  const row = rows[0];
  return row
    ? { codeHash: row.code_hash, expiresAt: row.expires_at, attempts: row.attempts }
    : undefined;
}

/** One more wrong code for the waiting one. */
export async function setEmailCodeAttempts(
  db: Queryable,
  accountId: string,
  attempts: number,
): Promise<void> {
  await db.query("UPDATE email_code SET attempts = $2 WHERE account_id = $1", [
    accountId,
    attempts,
  ]);
}

/** The waiting code goes: expired, spent by its wrong attempts, or used. */
export async function deleteEmailCode(db: Queryable, accountId: string): Promise<void> {
  await db.query("DELETE FROM email_code WHERE account_id = $1", [accountId]);
}

/** The address is confirmed (ADR-043 §3); a tombstone and an account without one take nothing. */
export async function confirmEmail(db: Queryable, accountId: string, at: Date): Promise<void> {
  await db.query(
    `UPDATE account SET email_confirmed_at = $2
     WHERE id = $1 AND state <> 'deleted' AND email IS NOT NULL`,
    [accountId, at],
  );
}

/** Erasure's share (ADR-007): the waiting code and the day's sends go with the account. */
export async function deleteEmailRows(db: Queryable, accountId: string): Promise<void> {
  await db.query("DELETE FROM email_code WHERE account_id = $1", [accountId]);
  await db.query("DELETE FROM email_send WHERE account_id = $1", [accountId]);
}

/**
 * registered becomes active once (the onboarding rule decides when); nothing
 * else changes here. A shadow ban set while the account was still registered
 * is honoured now (ADR-024 §2). The row's lock comes first and the decision
 * in a statement of its own: a subquery inside the UPDATE would read the
 * statement's snapshot and miss a ban that committed while it waited.
 */
export async function activateAccount(
  db: Queryable,
  accountId: string,
  at: Date,
): Promise<boolean> {
  return transaction(db, async (tx) => {
    await tx.query("SELECT 1 FROM account WHERE id = $1 FOR UPDATE", [accountId]);
    const result = await tx.query(
      `UPDATE account SET state_changed_at = $2,
         state = CASE WHEN EXISTS (
           SELECT 1 FROM sanction s
           WHERE s.account_id = $1 AND s.kind = 'shadow_ban' AND s.lifted_at IS NULL)
         THEN 'shadow_banned'::account_state ELSE 'active'::account_state END
       WHERE id = $1 AND state = 'registered'`,
      [accountId, at],
    );
    return result.rowCount === 1;
  });
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

/** Erasure (#51, ADR-010 §14): the consent rows go with the account; the events keep their own consent_version. */
export async function deleteConsentsOfAccount(db: Queryable, accountId: string): Promise<number> {
  const result = await db.query("DELETE FROM consent WHERE account_id = $1", [accountId]);
  return result.rowCount ?? 0;
}

export type ExportRecord = {
  /** True while the account is live; false means it was erased between the guard and here. */
  live: boolean;
  /** Exports answered since the day started, before this one. */
  used: number;
  /** True when the request was within the day's cap and its row was written. */
  recorded: boolean;
  /** The row's id when recorded, for giving the copy back if the archive never gets built. */
  id: string | null;
};

/**
 * One export answered (#237, ADR-007 §3): the day's count and the row in one
 * statement under an advisory lock per account, so two requests cannot both
 * pass a separate count; the shape of the fetch log's budget (media/repo.ts).
 * Over the cap nothing is written; the caller refuses with the wait.
 */
export async function recordExport(
  db: Queryable,
  input: {
    accountId: string;
    at: Date;
    /** Start of the cap's day; rows from before it do not count. */
    since: Date;
    limit: number;
  },
): Promise<ExportRecord> {
  return transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `account_export:${input.accountId}`,
    ]);
    const { rows } = await tx.query<{ live: boolean; used: number; id: string | null }>(
      `WITH live AS (SELECT 1 FROM account WHERE id = $1 AND state <> 'deleted'),
          used AS (SELECT count(*)::int AS n FROM account_export WHERE account_id = $1 AND at >= $3),
          ins AS (INSERT INTO account_export (account_id, at)
                  SELECT $1, $2 FROM live, used WHERE used.n < $4
                  RETURNING id)
     SELECT EXISTS (SELECT 1 FROM live) AS live,
            (SELECT n FROM used) AS used,
            (SELECT id FROM ins) AS id`,
      [input.accountId, input.at, input.since, input.limit],
    );
    const row = rows[0];
    if (!row) throw new Error("account_export insert returned no row");
    return { live: row.live, used: row.used, recorded: row.id !== null, id: row.id };
  });
}

/** The copy given back (#237): the archive was never built, so the day's cap should not count it. */
export async function deleteExport(db: Queryable, accountId: string, id: string): Promise<void> {
  await db.query("DELETE FROM account_export WHERE id = $1 AND account_id = $2", [id, accountId]);
}

/** The person's requests for a copy, newest first, for the export (#237). */
export async function listExportsOfAccount(
  db: Queryable,
  accountId: string,
  limit: number,
): Promise<Array<{ at: Date }>> {
  const { rows } = await db.query<{ at: Date }>(
    "SELECT at FROM account_export WHERE account_id = $1 ORDER BY at DESC LIMIT $2",
    [accountId, limit],
  );
  return rows.map((r) => ({ at: r.at }));
}

/** Erasure (#51): the export requests are the person's trail and go with the account. */
export async function deleteExportsOfAccount(db: Queryable, accountId: string): Promise<number> {
  const result = await db.query("DELETE FROM account_export WHERE account_id = $1", [accountId]);
  return result.rowCount ?? 0;
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
