import { randomBytes } from "node:crypto";
import type { AdminSession } from "@kuutti/schema";
import { type AdminSessionStore, hashToken } from "../lib/admin-middleware.ts";
import { AppError } from "../lib/errors.ts";
import { hashOneTimeCode, newOneTimeCode, ONE_TIME_CODE_TTL_MS } from "./codes.ts";
import type { LoginDeps } from "./login.ts";
import * as repo from "./repo.ts";

// Staff sign-in (#49, rules/api.md Identity, rules/admin.md): the same bank
// login as everyone's, on the same callback, but the request is marked
// "admin" and resolves to an identity with a moderator_roles row rather than
// to an account. Nothing is created: a person without a role is refused and
// no identity or account appears. The session is eight hours, one bearer
// token kept as a hash, no refresh; the browser is sent back to the admin
// panel with a one-time code in the URL fragment, which no server ever sees.

export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const ADMIN_PLATFORM = "admin";

export type AdminLoginDeps = LoginDeps & { adminAppUrl: string };

/** Back to the panel: the code rides in the fragment, so it reaches the SPA and no log. */
function adminReturnUrl(adminAppUrl: string, code: string): URL {
  const url = new URL(adminAppUrl);
  url.hash = `code=${encodeURIComponent(code)}`;
  return url;
}

export function adminErrorUrl(adminAppUrl: string, code: string): URL {
  const url = new URL(adminAppUrl);
  url.hash = `error=${encodeURIComponent(code)}`;
  return url;
}

/**
 * The admin half of the callback, after the bank has answered and the hetu
 * has become hetu_hmac (login.ts owns that part). A known identity in good
 * standing with a role gets a one-time code; anyone else is refused with
 * admin_not_allowed and the attempt is spent, as every refusal's is
 * (completeLogin, ADR-026 §8).
 */
export async function completeAdminLogin(
  deps: AdminLoginDeps,
  input: {
    request: { id: string };
    hetuHmac: string;
    reference: repo.BrokerReference;
    now: Date;
  },
): Promise<URL> {
  const identity = await repo.findIdentityByHmac(deps.db, input.hetuHmac);
  const role = identity ? await repo.findModeratorRole(deps.db, identity.id) : null;
  if (!identity || !role || identity.standing !== "ok") {
    throw new AppError(403, "admin_not_allowed", "This bank login has no moderator role", {
      known: identity !== null,
      standing: identity?.standing ?? null,
    });
  }
  await repo.updateBrokerReference(deps.db, identity.id, input.reference);
  const { code, hash } = newOneTimeCode();
  await repo.attachAdminCode(deps.db, {
    id: input.request.id,
    codeHash: hash,
    codeExpiresAt: new Date(input.now.getTime() + ONE_TIME_CODE_TTL_MS),
    identityId: identity.id,
  });
  return adminReturnUrl(deps.adminAppUrl, code);
}

/** /admin/auth/exchange: the code, once, within its minute; the role is read again at this moment. */
export async function exchangeAdminCode(
  deps: Pick<LoginDeps, "db" | "now">,
  code: string,
): Promise<AdminSession> {
  const now = deps.now();
  const request = await repo.findAuthRequestByCodeHash(deps.db, hashOneTimeCode(code));
  const valid =
    request !== null &&
    request.platform === ADMIN_PLATFORM &&
    request.identityId !== null &&
    request.codeExpiresAt !== null &&
    request.codeExpiresAt.getTime() >= now.getTime() &&
    (await repo.consumeCode(deps.db, request.id, now));
  if (!valid || request === null || request.identityId === null) {
    throw new AppError(401, "auth_code_used", "This code is unknown, used or expired");
  }
  const role = await repo.findModeratorRole(deps.db, request.identityId);
  if (!role) throw new AppError(403, "admin_not_allowed", "The role is gone");
  const accessToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + ADMIN_SESSION_TTL_MS);
  const session = await repo.insertAdminSession(deps.db, {
    identityId: request.identityId,
    role,
    accessHash: hashToken(accessToken),
    expiresAt,
    at: now,
  });
  // A suspension or a ban that landed between the bank and the exchange (ADR-024 §4).
  if (!session) throw new AppError(403, "admin_not_allowed", "The standing changed");
  return { accessToken, expiresAt: expiresAt.toISOString(), role };
}

export async function endAdminSession(
  deps: Pick<LoginDeps, "db" | "now">,
  sessionId: string,
): Promise<void> {
  await repo.revokeAdminSession(deps.db, sessionId, deps.now());
}

/** What lib/admin-middleware.ts reads through; the queries stay in the slice. */
export const adminSessionStore: AdminSessionStore = {
  async findByAccessHash(db, accessHash) {
    const found = await repo.findAdminSessionByAccessHash(db, accessHash);
    if (!found) return null;
    return {
      sessionId: found.id,
      identityId: found.identityId,
      role: found.role,
      currentRole: found.currentRole,
      expiresAt: found.expiresAt,
      revokedAt: found.revokedAt,
      identityStanding: found.identityStanding,
    };
  },
  touch: repo.touchAdminSession,
};

export async function sweepAdminSessions(
  deps: Pick<LoginDeps, "db" | "now">,
): Promise<{ adminSessions: number }> {
  return { adminSessions: await repo.deleteDeadAdminSessions(deps.db, deps.now()) };
}
