import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "@kuutti/db";
import type { ModeratorRole } from "@kuutti/schema";
import { hashToken } from "../lib/auth-middleware.ts";
import { SPECIAL_CATEGORY_CONSENT_VERSION } from "../profile/index.ts";

/**
 * A verified account with one live device session, written straight into the
 * test transaction: what a route test needs to call a guarded route as
 * somebody. Plain SQL rather than the identity slice's functions, because a
 * test of another slice may not import identity's internals (rules/layout.md)
 * and a bank login through the routes is the identity tests' business.
 */
export type SignedIn = {
  accountId: string;
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  /** Ready for `app.request(path, { headers })`. */
  headers: { authorization: string };
};

export async function signedInAccount(
  db: Queryable,
  label?: string,
  options: { state?: "registered" | "active" } = {},
): Promise<SignedIn> {
  const who = label ?? randomBytes(6).toString("hex");
  // A hash of the label, never of any code: no bank login maps to it.
  const hetuHmac = createHash("sha256").update(`kuutti test account: ${who}`).digest("hex");
  const identity = await db.query<{ id: string }>(
    "INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id",
    [hetuHmac],
  );
  const identityId = identity.rows[0]?.id;
  if (!identityId) throw new Error("test identity not written");
  const account = await db.query<{ id: string }>(
    "INSERT INTO account (identity_id, state, birth_year, birth_month) VALUES ($1, $2, 1990, 6) RETURNING id",
    [identityId, options.state ?? "active"],
  );
  const accountId = account.rows[0]?.id;
  if (!accountId) throw new Error("test account not written");

  const accessToken = randomBytes(32).toString("base64url");
  // The refresh token's shape (ADR-059): the session's secret, a dot, the rotating part.
  const family = randomBytes(32).toString("base64url");
  const refreshToken = `${family}.${randomBytes(32).toString("base64url")}`;
  const now = Date.now();
  const session = await db.query<{ id: string }>(
    `INSERT INTO session (account_id, platform, access_hash, access_expires_at, refresh_hash, family_hash, expires_at)
     VALUES ($1, 'ios', $2, $3, $4, $5, $6) RETURNING id`,
    [
      accountId,
      hashToken(accessToken),
      new Date(now + 15 * 60 * 1000),
      hashToken(refreshToken),
      hashToken(family),
      new Date(now + 90 * 24 * 60 * 60 * 1000),
    ],
  );
  const sessionId = session.rows[0]?.id;
  if (!sessionId) throw new Error("test session not written");
  return {
    accountId,
    sessionId,
    accessToken,
    refreshToken,
    headers: { authorization: `Bearer ${accessToken}` },
  };
}

/** A signed-in account with the sensitive-answers consent of the current wording, which a save of whom one seeks needs (ADR-010 §16). */
export async function consentedAccount(db: Queryable, label?: string): Promise<SignedIn> {
  const account = await signedInAccount(db, label);
  await db.query(
    `INSERT INTO consent (account_id, kind, version, locale_shown)
     VALUES ($1, 'special_category', $2, 'fi')`,
    [account.accountId, SPECIAL_CATEGORY_CONSENT_VERSION],
  );
  return account;
}

/**
 * A device session for an account that exists already, such as one of
 * `people()`: what a route test needs to call as that person.
 */
export async function signInAs(
  db: Queryable,
  accountId: string,
): Promise<{ accountId: string; headers: { authorization: string } }> {
  const accessToken = randomBytes(32).toString("base64url");
  const family = randomBytes(32).toString("base64url");
  const refreshToken = `${family}.${randomBytes(32).toString("base64url")}`;
  const now = Date.now();
  await db.query(
    `INSERT INTO session (account_id, platform, access_hash, access_expires_at, refresh_hash, family_hash, expires_at)
     VALUES ($1, 'ios', $2, $3, $4, $5, $6)`,
    [
      accountId,
      hashToken(accessToken),
      new Date(now + 15 * 60 * 1000),
      hashToken(refreshToken),
      hashToken(family),
      new Date(now + 90 * 24 * 60 * 60 * 1000),
    ],
  );
  return { accountId, headers: { authorization: `Bearer ${accessToken}` } };
}

/**
 * matching_config values a test needs, inside its transaction (rolled back
 * with it): each the key's next version, as the panel writes one, so it is
 * the value read whatever version a migration left last (0088's second
 * version of the photo rule, #513).
 */
export async function withMatchingConfig(
  db: Queryable,
  values: Record<string, unknown>,
): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    await db.query(
      `INSERT INTO matching_config (version, key, value, created_by)
       SELECT coalesce(max(version), 0) + 1, $1, $2::jsonb, 'test' FROM matching_config WHERE key = $1`,
      [key, JSON.stringify(value)],
    );
  }
}

export type Staff = {
  identityId: string;
  sessionId: string;
  accessToken: string;
  role: ModeratorRole;
  headers: { authorization: string };
};

/**
 * A member of staff (#49): an identity with a moderator_roles row and one
 * admin session, written straight into the test transaction. Plain SQL for
 * the same reason as signedInAccount.
 */
export async function staffSession(
  db: Queryable,
  role: ModeratorRole = "moderator",
  label?: string,
): Promise<Staff> {
  const who = label ?? `staff-${randomBytes(6).toString("hex")}`;
  const hetuHmac = createHash("sha256").update(`kuutti test staff: ${who}`).digest("hex");
  const identity = await db.query<{ id: string }>(
    "INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id",
    [hetuHmac],
  );
  const identityId = identity.rows[0]?.id;
  if (!identityId) throw new Error("test staff identity not written");
  await db.query(
    "INSERT INTO moderator_roles (identity_id, role, granted_by) VALUES ($1, $2, 'test')",
    [identityId, role],
  );
  const accessToken = randomBytes(32).toString("base64url");
  const session = await db.query<{ id: string }>(
    `INSERT INTO admin_session (identity_id, role, access_hash, expires_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [identityId, role, hashToken(accessToken), new Date(Date.now() + 8 * 60 * 60 * 1000)],
  );
  const sessionId = session.rows[0]?.id;
  if (!sessionId) throw new Error("test admin session not written");
  return {
    identityId,
    sessionId,
    accessToken,
    role,
    headers: { authorization: `Bearer ${accessToken}` },
  };
}
