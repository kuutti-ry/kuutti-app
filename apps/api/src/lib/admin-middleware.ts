import type { Queryable } from "@kuutti/db";
import type { ModeratorRole } from "@kuutti/schema";
import type { Context, MiddlewareHandler } from "hono";
import { hashToken } from "./auth-middleware.ts";
import type { AppEnv } from "./env.ts";
import { AppError } from "./errors.ts";

// The staff guard (#49, security checklist line 10: admin routes check the
// role server-side, the allowlist is by hetu_hmac through the identity row).
// A product session token never passes here and an admin token never passes
// requireSession: two tables, two guards. The role is read from the
// moderator_roles row at every request, so a role removed today ends the
// access today, eight-hour token or not.

export { hashToken };

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type AdminLookup = {
  sessionId: string;
  identityId: string;
  /** The role the session was issued with. */
  role: ModeratorRole;
  /** The role the identity holds now; null when it was taken away. */
  currentRole: ModeratorRole | null;
  expiresAt: Date;
  revokedAt: Date | null;
  identityStanding: string;
};

export type AdminSessionStore = {
  findByAccessHash(db: Queryable, accessHash: string): Promise<AdminLookup | null>;
  touch(db: Queryable, sessionId: string, at: Date): Promise<void>;
};

export function requireAdmin(deps: {
  db: Queryable;
  store: AdminSessionStore;
  /** Roles this route admits; the role check is here, never in the handler. */
  roles: readonly ModeratorRole[];
  now?: () => Date;
  /** The person's limiter (ADR-026 §1), run once the staff identity is known and before the touch. */
  limit?: MiddlewareHandler<AppEnv>;
}): MiddlewareHandler<AppEnv> {
  const now = deps.now ?? (() => new Date());
  // The function's name is what the route-table test looks for, and the roles
  // ride on it so the test can hold a route to the guard it needs (ADR-024 §3).
  const guard: MiddlewareHandler<AppEnv> = async function requireAdmin(c, next) {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!TOKEN.test(token)) throw new AppError(401, "unauthenticated", "No admin token");
    const found = await deps.store.findByAccessHash(deps.db, hashToken(token));
    const at = now();
    if (!found) throw new AppError(401, "unauthenticated", "Unknown admin token");
    if (found.revokedAt !== null || found.identityStanding !== "ok" || found.currentRole === null) {
      throw new AppError(401, "session_revoked", "The admin session was ended");
    }
    if (found.expiresAt.getTime() < at.getTime()) {
      throw new AppError(401, "session_expired", "The admin session has expired");
    }
    if (!deps.roles.includes(found.currentRole)) {
      throw new AppError(403, "admin_forbidden", "This role does not allow that", {
        role: found.currentRole,
      });
    }
    c.set("adminIdentityId", found.identityId);
    c.set("adminRole", found.currentRole);
    c.set("adminSessionId", found.sessionId);
    c.set("adminExpiresAt", found.expiresAt.toISOString());
    // A request the limiter refuses writes nothing, not even the touch.
    const admitted = async () => {
      await deps.store.touch(deps.db, found.sessionId, at);
      await next();
    };
    return deps.limit ? deps.limit(c, admitted) : admitted();
  };
  return Object.assign(guard, { roles: deps.roles });
}

export type Staff = {
  identityId: string;
  role: ModeratorRole;
  sessionId: string;
  /** When the session ends, ISO 8601; what the panel shows and nothing else. */
  expiresAt: string;
};

/** The member of staff behind requireAdmin; throwing here means the guard is missing. */
export function staffOf(c: Context<AppEnv>): Staff {
  const identityId = c.get("adminIdentityId");
  const role = c.get("adminRole");
  const sessionId = c.get("adminSessionId");
  const expiresAt = c.get("adminExpiresAt");
  if (!identityId || !role || !sessionId || !expiresAt) {
    throw new AppError(401, "unauthenticated", "No admin session");
  }
  return { identityId, role, sessionId, expiresAt };
}
