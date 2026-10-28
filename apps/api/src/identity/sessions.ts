import { randomBytes } from "node:crypto";
import type { Queryable } from "@kuutti/db";
import type { AuthPlatform, SessionResponse, SessionTokens } from "@kuutti/schema";
import { hashToken } from "../lib/auth-middleware.ts";
import { AppError } from "../lib/errors.ts";
import * as repo from "./repo.ts";

// Device-bound sessions (#35, TD-1). Tokens are 256-bit random values that
// exist in plaintext only in the response; the row keeps SHA-256 hashes. A
// refresh rotates both tokens and retires the old refresh token on the row, so
// a second presentation of it is recognised as reuse and ends the device.
// A refresh also moves the session's end (ADR-058): a phone in use stays signed
// in, one left alone for ninety days, or a year past its bank login, goes to
// the bank again.

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
/** A session ends this long after the bank login or its last refresh (ADR-058 §1). */
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** And never later than this after its bank login, however often it is used (ADR-058 §2). */
const SESSION_CEILING_MS = 365 * 24 * 60 * 60 * 1000;
/** Ended sessions stay this long for the person's device list and for support, then the sweep removes them. */
const ENDED_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionDeps = { db: Queryable; now: () => Date };

const newToken = () => randomBytes(32).toString("base64url");

function pair(now: Date) {
  const accessToken = newToken();
  const refreshToken = newToken();
  return {
    accessToken,
    refreshToken,
    accessHash: hashToken(accessToken),
    refreshHash: hashToken(refreshToken),
    accessExpiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
  };
}

/** A fresh session for the device that just exchanged a one-time code. */
export async function issueSession(
  deps: SessionDeps,
  input: { accountId: string; platform: AuthPlatform; userAgent: string | null },
): Promise<SessionTokens> {
  const now = deps.now();
  const tokens = pair(now);
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
  const row = await repo.insertSession(deps.db, {
    accountId: input.accountId,
    platform: input.platform,
    userAgent: input.userAgent,
    accessHash: tokens.accessHash,
    accessExpiresAt: tokens.accessExpiresAt,
    refreshHash: tokens.refreshHash,
    expiresAt: refreshExpiresAt,
    at: now,
  });
  // The account was erased between the callback and the exchange (#51): the
  // code reads as spent, and the person signs in again into a fresh account
  // once the cooldown has passed.
  if (!row) throw new AppError(401, "auth_code_used", "This code is unknown, used or expired");
  return {
    sessionId: row.id,
    accessToken: tokens.accessToken,
    accessExpiresAt: tokens.accessExpiresAt.toISOString(),
    refreshToken: tokens.refreshToken,
    refreshExpiresAt: refreshExpiresAt.toISOString(),
  };
}

/**
 * Rotation with reuse detection. The update is keyed by the live refresh hash,
 * so of two concurrent refreshes exactly one wins; the loser, and anyone who
 * copied the token, presents a retired hash and ends the session for the
 * device (the OAuth 2.0 Security BCP's answer to refresh token theft).
 */
export async function refreshSession(
  deps: SessionDeps,
  refreshToken: string,
): Promise<SessionTokens> {
  const now = deps.now();
  const presented = hashToken(refreshToken);
  const tokens = pair(now);
  const rotated = await repo.rotateSession(deps.db, {
    refreshHash: presented,
    nextAccessHash: tokens.accessHash,
    nextAccessExpiresAt: tokens.accessExpiresAt,
    nextRefreshHash: tokens.refreshHash,
    nextExpiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
    ceilingMs: SESSION_CEILING_MS,
    at: now,
  });
  if (rotated) {
    return {
      sessionId: rotated.id,
      accessToken: tokens.accessToken,
      accessExpiresAt: tokens.accessExpiresAt.toISOString(),
      refreshToken: tokens.refreshToken,
      refreshExpiresAt: rotated.expiresAt.toISOString(),
    };
  }
  const reused = await repo.findSessionByRetiredRefreshHash(deps.db, presented);
  if (reused && reused.revokedAt === null) {
    await repo.revokeSession(deps.db, reused.id, now, "refresh_reuse");
  }
  // A retired, revoked, expired or unknown token all read the same to the
  // caller: this device signs in through the bank again.
  throw new AppError(401, "session_revoked", "The refresh token is not valid", {
    reason: reused ? "reuse" : "unknown_or_expired",
  });
}

export async function endSession(deps: SessionDeps, sessionId: string): Promise<void> {
  await repo.revokeSession(deps.db, sessionId, deps.now(), "logout");
}

/** Every device of the account, including the one asking. */
export async function endAllSessions(deps: SessionDeps, accountId: string): Promise<number> {
  return repo.revokeAccountSessions(deps.db, accountId, deps.now(), "logout_all");
}

export async function describeSession(
  deps: SessionDeps,
  caller: { accountId: string; sessionId: string },
): Promise<SessionResponse> {
  // Scoped by the caller's account in the query (rule 6), not by a check after.
  const row = await repo.findSessionForAccount(deps.db, caller.sessionId, caller.accountId);
  if (!row) throw new AppError(401, "session_revoked", "The session was ended");
  return {
    sessionId: row.id,
    accountId: row.accountId,
    platform: row.platform === "android" ? "android" : "ios",
    createdAt: row.createdAt.toISOString(),
    refreshExpiresAt: row.expiresAt.toISOString(),
  };
}

/** The nightly sweep: ended sessions past retention, expired ones, and stale login attempts. */
export async function sweepSessions(
  deps: SessionDeps,
): Promise<{ sessions: number; authRequests: number }> {
  const now = deps.now();
  const sessions = await repo.deleteDeadSessions(
    deps.db,
    new Date(now.getTime() - ENDED_SESSION_RETENTION_MS),
    now,
  );
  const authRequests = await repo.deleteExpiredAuthRequests(deps.db, now);
  return { sessions, authRequests };
}
