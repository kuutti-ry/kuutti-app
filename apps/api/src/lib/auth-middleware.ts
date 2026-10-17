import { createHash } from "node:crypto";
import type { Queryable } from "@kuutti/db";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, Caller } from "./env.ts";
import { AppError } from "./errors.ts";

// The session token check (#35, security checklist "session tokens"): the
// bearer value is hashed and looked up; the row's expiry and revocation and the
// account's state decide. Everything a product route reads about the caller
// comes from here (rule 6), and app.test.ts checks that every route outside the
// public list sits behind it.

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type SessionLookup = {
  accountId: string;
  sessionId: string;
  accessExpiresAt: Date;
  revokedAt: Date | null;
  accountState: string;
  identityStanding: string;
};

export type SessionStore = {
  findByAccessHash(db: Queryable, accessHash: string): Promise<SessionLookup | null>;
  touch(db: Queryable, sessionId: string, at: Date): Promise<void>;
  /** How an authenticated session stands now, by its id: the chat's open socket asks on each ping (#349). */
  standing(db: Queryable, caller: Caller, at: Date): Promise<"live" | "expired" | "ended">;
};

export const hashToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

/** Account states whose sessions still answer; a sanction on the identity ends them regardless. */
const LIVE_STATES = new Set(["registered", "active", "paused", "shadow_banned"]);

/**
 * The access token's check, the one code path for the session guard and the
 * chat socket's first frame (#349): hashed, looked up, the session not
 * revoked, the account in a live state, the identity in good standing, the
 * token not expired. Throws the guard's 401s; the session's lookup otherwise.
 */
export async function authenticate(
  deps: { db: Queryable; store: Pick<SessionStore, "findByAccessHash"> },
  token: string,
  at: Date,
): Promise<SessionLookup> {
  if (!TOKEN.test(token)) {
    throw new AppError(401, "unauthenticated", "No session token");
  }
  const found = await deps.store.findByAccessHash(deps.db, hashToken(token));
  if (!found) throw new AppError(401, "unauthenticated", "Unknown session token");
  if (
    found.revokedAt !== null ||
    !LIVE_STATES.has(found.accountState) ||
    found.identityStanding !== "ok"
  ) {
    throw new AppError(401, "session_revoked", "The session was ended");
  }
  if (found.accessExpiresAt.getTime() < at.getTime()) {
    throw new AppError(401, "session_expired", "The access token has expired");
  }
  return found;
}

export function requireSession(deps: {
  db: Queryable;
  store: Pick<SessionStore, "findByAccessHash" | "touch">;
  now?: () => Date;
  /** The person's limiter (ADR-026 §1), run once the account is known and before the touch. */
  limit?: MiddlewareHandler<AppEnv>;
}): MiddlewareHandler<AppEnv> {
  const now = deps.now ?? (() => new Date());
  // The function's name is what the route-table test looks for.
  return async function requireSession(c, next) {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const at = now();
    const found = await authenticate(deps, token, at);
    c.set("accountId", found.accountId);
    c.set("sessionId", found.sessionId);
    // A request the limiter refuses writes nothing, not even the touch.
    const admitted = async () => {
      await deps.store.touch(deps.db, found.sessionId, at);
      await next();
    };
    return deps.limit ? deps.limit(c, admitted) : admitted();
  };
}

/** The caller of a route behind requireSession; throwing here means the middleware is missing. */
export function callerOf(c: Context<AppEnv>): Caller {
  const accountId = c.get("accountId");
  const sessionId = c.get("sessionId");
  if (!accountId || !sessionId) throw new AppError(401, "unauthenticated", "No session");
  return { accountId, sessionId };
}
