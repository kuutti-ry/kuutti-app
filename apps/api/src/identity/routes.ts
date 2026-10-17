import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  AdminAuthExchangeRequest,
  AdminAuthStartQuery,
  AdminSession,
  AdminWhoAmI,
  AuthCallbackQuery,
  AuthExchangeRequest,
  AuthExchangeResponse,
  AuthRefreshRequest,
  AuthStartQuery,
  ErrorResponse,
  SessionResponse,
  SessionTokens,
  USER_AGENT_MAX,
} from "@kuutti/schema";
import type { Context, MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { staffOf } from "../lib/admin-middleware.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { AppError } from "../lib/errors.ts";
import { isLocalisedErrorCode } from "../lib/i18n.ts";
import { addressOf, rateLimit } from "../lib/rate-limit.ts";
import {
  ADMIN_PLATFORM,
  adminErrorUrl,
  endAdminSession,
  exchangeAdminCode,
} from "./admin-session.ts";
import { appErrorUrl } from "./codes.ts";
import { hmacKeyFromHex } from "./hetu.ts";
import { completeLogin, exchangeCode, type LoginDeps, startLogin } from "./login.ts";
import {
  describeSession,
  endAllSessions,
  endSession,
  issueSession,
  refreshSession,
  type SessionDeps,
} from "./sessions.ts";

const errorContent = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const bearer = { security: [{ session: [] }] };

/** The sign-in doors' window (ADR-026 §4): a minute, which the demo's wait of at most 65 s outlasts. */
const SIGN_IN_WINDOW_MS = 60_000;
/**
 * The doors count an IPv6 client by its /56 (ADR-026 §1, §4): one subscriber
 * is usually given a /56, 256 /64s, and counted by /64 one home would have
 * 256 windows to fill the table with. The address's own limit keeps the /64.
 */
const SIGN_IN_IPV6_PREFIX = 56;

/** The cooldown's date, when the refusal carries one. */
function untilOf(detail: unknown): string | undefined {
  const until = (detail as { until?: unknown } | undefined)?.until;
  return typeof until === "string" ? until : undefined;
}

/** True when the refused attempt was a staff login (#49): the browser goes to the panel. */
function isAdminAttempt(detail: unknown): boolean {
  return (detail as { platform?: unknown } | undefined)?.platform === ADMIN_PLATFORM;
}

const startRoute = createRoute({
  method: "get",
  path: "/auth/start",
  summary: "Begin a bank login",
  description:
    "Opened in the system browser by the app, with the SHA-256 of the app's verifier for this attempt (code_challenge, ADR-027). Redirects to the identification broker's bank chooser; the person comes back through /auth/callback and the app receives a one-time code by deep link.",
  request: { query: AuthStartQuery },
  responses: {
    302: {
      description:
        "Redirect to the broker; where none is configured (a pull-request preview, ADR-014 §1), to kuutti://auth?error=auth_unavailable; when this address has sent too many requests or started too many sign-ins, or too many are under way at once (ADR-026), to kuutti://auth?error=auth_rate_limited with Retry-After.",
    },
    400: errorContent("Validation failed."),
    503: errorContent("No identification broker is configured (anywhere but a preview)."),
  },
});

const callbackRoute = createRoute({
  method: "get",
  path: "/auth/callback",
  summary: "The broker's return",
  description:
    "The registered redirect URI. Exchanges the code with the broker, derives the identity, applies the re-registration rule and redirects to the app's deep link with a one-time code. A state is answered once: its second return, at once or later, is auth_state_mismatch without a call to the broker. Never called by the app itself.",
  request: { query: AuthCallbackQuery },
  responses: {
    302: {
      description:
        "Redirect to kuutti://auth?code=… on success, or to kuutti://auth?error=<code> (auth_state_mismatch, auth_cancelled, auth_under_18, auth_banned, auth_suspended with &until=<date> when the suspension has an end, auth_cooldown with &until=<date>, auth_provider_error) so the app shows the refusal.",
    },
  },
});

const exchangeRoute = createRoute({
  method: "post",
  path: "/auth/exchange",
  summary: "Exchange the one-time code for a session",
  description:
    "Single use, within 60 seconds of the callback, and only with the verifier whose SHA-256 the attempt's /auth/start carried (ADR-027); a wrong verifier leaves the code unspent. Answers with this device's access and refresh tokens; the app keeps both in secure storage.",
  request: { body: json(AuthExchangeRequest) },
  responses: {
    200: { description: "The device's session.", ...json(AuthExchangeResponse) },
    400: errorContent("Validation failed."),
    401: errorContent(
      "Unknown, used or expired code, or a verifier that is not its attempt's (auth_code_used).",
    ),
    429: errorContent(
      "rate_limited: too many requests from this address (ADR-026 §1); Retry-After is the wait.",
    ),
  },
});

const refreshRoute = createRoute({
  method: "post",
  path: "/auth/refresh",
  summary: "Rotate the session's tokens",
  description:
    "Presents the refresh token, receives a new pair; the old refresh token is retired. Presenting a retired token ends the device's session (session_revoked): sign in through the bank again.",
  request: { body: json(AuthRefreshRequest) },
  responses: {
    200: { description: "The new pair.", ...json(SessionTokens) },
    400: errorContent("Validation failed."),
    401: errorContent("Retired, revoked, expired or unknown refresh token (session_revoked)."),
  },
});

const sessionRoute = createRoute({
  method: "get",
  path: "/auth/session",
  summary: "This device's session",
  ...bearer,
  responses: {
    200: { description: "The caller's own session.", ...json(SessionResponse) },
    401: errorContent("unauthenticated, session_expired or session_revoked."),
  },
});

const logoutRoute = createRoute({
  method: "post",
  path: "/auth/logout",
  summary: "Sign out this device",
  ...bearer,
  responses: {
    204: { description: "The session is ended; both tokens stop working." },
    401: errorContent("unauthenticated, session_expired or session_revoked."),
  },
});

const logoutAllRoute = createRoute({
  method: "post",
  path: "/auth/logout-all",
  summary: "Sign out every device",
  description: "Recovery for a lost phone: every session of the account ends, including this one.",
  ...bearer,
  responses: {
    204: { description: "Every session of the account is ended." },
    401: errorContent("unauthenticated, session_expired or session_revoked."),
  },
});

const adminStartRoute = createRoute({
  method: "get",
  path: "/admin/auth/start",
  summary: "Begin a staff bank login",
  description:
    "Opened by the moderation panel. The same bank login as the app's, marked as a staff attempt: it resolves to an identity with a moderator role and creates nothing. The browser returns to the panel with a one-time code in the URL fragment, or with error=admin_not_allowed.",
  request: { query: AdminAuthStartQuery },
  responses: {
    302: {
      description:
        "Redirect to the broker; when this address has sent too many requests or started too many sign-ins, or too many are under way at once (ADR-026), to the panel with error=auth_rate_limited in the fragment and Retry-After.",
    },
    400: errorContent("Validation failed."),
    503: errorContent("No identification broker is configured."),
  },
});

const adminExchangeRoute = createRoute({
  method: "post",
  path: "/admin/auth/exchange",
  summary: "Exchange a staff one-time code for an admin session",
  description: "Single use, within 60 seconds. Eight hours, no refresh; sign in again afterwards.",
  request: { body: json(AdminAuthExchangeRequest) },
  responses: {
    200: { description: "The admin session.", ...json(AdminSession) },
    400: errorContent("Validation failed."),
    401: errorContent("Unknown, used or expired code (auth_code_used)."),
    403: errorContent("admin_not_allowed: the role was taken away meanwhile."),
    429: errorContent(
      "rate_limited: too many requests from this address (ADR-026 §1); Retry-After is the wait.",
    ),
  },
});

const adminWhoAmIRoute = createRoute({
  method: "get",
  path: "/admin/whoami",
  summary: "This admin session",
  ...bearer,
  responses: {
    200: { description: "The role and when the session ends.", ...json(AdminWhoAmI) },
    401: errorContent("unauthenticated, session_expired or session_revoked."),
  },
});

const adminLogoutRoute = createRoute({
  method: "post",
  path: "/admin/auth/logout",
  summary: "End this admin session",
  ...bearer,
  responses: {
    204: { description: "The session is ended." },
    401: errorContent("unauthenticated, session_expired or session_revoked."),
  },
});

/** The two sign-in starts, the doors a browser opens (ADR-026 §4). */
export function isSignInStart(path: string): boolean {
  return path === startRoute.path || path === adminStartRoute.path;
}

/**
 * A start refused for the rate of sign-ins, by an address's window or the
 * table's ceiling (ADR-026 §4, §6), goes where every other sign-in refusal
 * goes: back to the app's link, or to the panel's page for a staff start, with
 * a code it has a text for, so nobody is left on a JSON page in the system
 * browser. Retry-After is set already. It leaves one line with the code and
 * which limit refused, never the address (§7).
 */
export function refuseSignInStart(
  c: Context<AppEnv>,
  deps: Pick<Deps, "config" | "logger">,
  limiter: "address" | "cap",
): Response {
  deps.logger.warn(
    { requestId: c.get("requestId"), code: "auth_rate_limited", detail: { limiter } },
    "sign-in refused",
  );
  const back =
    c.req.path === adminStartRoute.path
      ? adminErrorUrl(deps.config.ADMIN_APP_URL, "auth_rate_limited").toString()
      : appErrorUrl("auth_rate_limited");
  return c.redirect(back, 302);
}

export function authRoutes(
  deps: Deps,
  requireSession: MiddlewareHandler<AppEnv>,
  requireAnyStaff: MiddlewareHandler<AppEnv>,
) {
  const app = new OpenAPIHono<AppEnv>();
  const hmacKey = deps.config.HETU_HMAC_KEY ? hmacKeyFromHex(deps.config.HETU_HMAC_KEY) : null;
  const now = () => new Date();
  const sessionDeps: SessionDeps = { db: deps.db, now };
  const adminAppUrl = deps.config.ADMIN_APP_URL;

  const loginDeps = (requestId: string): LoginDeps => {
    if (!deps.broker || !hmacKey) {
      throw new AppError(503, "auth_provider_error", "Bank identification is not configured here");
    }
    return {
      db: deps.db,
      broker: deps.broker,
      hmacKey,
      now,
      adminAppUrl,
      logger: deps.logger.child({ requestId }),
    };
  };

  // The doors' own window per address, one for the two starts, on each path
  // before its handler: a refused start writes no attempt and has the broker
  // sign nothing (ADR-026 §4). The exchanges are no doors: a person who has
  // been to the bank is not refused at the last step for the rate of starts.
  const doors = rateLimit({
    limit: deps.config.SIGN_IN_RATE_LIMIT_PER_MINUTE,
    windowMs: SIGN_IN_WINDOW_MS,
    keyOf: addressOf(deps.config.TRUSTED_PROXY, { ipv6Prefix: SIGN_IN_IPV6_PREFIX }),
    refuse: (c) => refuseSignInStart(c, deps, "address"),
  });
  for (const route of [startRoute, adminStartRoute]) {
    app.use(route.getRoutingPath(), doors);
  }

  // The table's ceiling refuses a start as the doors do, the doors' window as
  // the wait (ADR-026 §6); anything else is the error it was.
  const whenFull = (c: Context<AppEnv>, error: unknown) => {
    if (!(error instanceof AppError && error.code === "auth_rate_limited")) throw error;
    c.header("Retry-After", String(SIGN_IN_WINDOW_MS / 1000));
    return refuseSignInStart(c, deps, "cap");
  };

  app.openapi(startRoute, async (c) => {
    const query = c.req.valid("query");
    // A pull-request preview has no bank (ADR-014 §1): the browser goes back
    // to the app, which says so, rather than stopping on a JSON page. Anywhere
    // else a missing broker stays a 503, which the 5xx alarm sees.
    if (deps.config.preview && (!deps.broker || !hmacKey)) {
      return c.redirect(appErrorUrl("auth_unavailable"), 302);
    }
    try {
      const url = await startLogin(loginDeps(c.get("requestId")), {
        platform: query.platform,
        locale: query.locale ?? c.get("locale"),
        codeChallenge: query.code_challenge,
      });
      return c.redirect(url.toString(), 302);
    } catch (error) {
      return whenFull(c, error);
    }
  });

  app.openapi(callbackRoute, async (c) => {
    const query = c.req.valid("query");
    try {
      const target = await completeLogin(loginDeps(c.get("requestId")), {
        callbackUrl: new URL(c.req.url),
        query,
      });
      return c.redirect(target.toString(), 302);
    } catch (error) {
      // The browser is on its way back to the app either way: a refusal lands
      // there as a code the app has a text for, not as a JSON page in a tab.
      if (error instanceof AppError && isLocalisedErrorCode(error.code)) {
        deps.logger.warn(
          { requestId: c.get("requestId"), code: error.code, detail: error.detail },
          error.message,
        );
        if (isAdminAttempt(error.detail)) {
          return c.redirect(adminErrorUrl(adminAppUrl, error.code).toString(), 302);
        }
        return c.redirect(appErrorUrl(error.code, untilOf(error.detail)), 302);
      }
      throw error;
    }
  });

  app.openapi(exchangeRoute, async (c) => {
    const { code, verifier } = c.req.valid("json");
    const login = await exchangeCode(sessionDeps, { code, verifier });
    const tokens = await issueSession(sessionDeps, {
      accountId: login.accountId,
      platform: login.platform,
      userAgent: c.req.header("user-agent")?.slice(0, USER_AGENT_MAX) ?? null,
    });
    return c.json({ ...tokens, outcome: login.outcome }, 200);
  });

  app.openapi(refreshRoute, async (c) => {
    const { refreshToken } = c.req.valid("json");
    return c.json(await refreshSession(sessionDeps, refreshToken), 200);
  });

  // The guard is registered on the path before the handler (app.test.ts
  // reads it from the route table); a route without it is a public route.
  for (const route of [sessionRoute, logoutRoute, logoutAllRoute]) {
    app.use(route.getRoutingPath(), requireSession);
  }

  app.openapi(sessionRoute, async (c) => {
    return c.json(await describeSession(sessionDeps, callerOf(c)), 200);
  });

  app.openapi(logoutRoute, async (c) => {
    await endSession(sessionDeps, callerOf(c).sessionId);
    return c.body(null, 204);
  });

  app.openapi(logoutAllRoute, async (c) => {
    await endAllSessions(sessionDeps, callerOf(c).accountId);
    return c.body(null, 204);
  });

  // Staff (#49): the start and the exchange are public like the app's; the
  // rest sits behind the admin guard, registered on the path before the handler.
  app.openapi(adminStartRoute, async (c) => {
    const query = c.req.valid("query");
    try {
      const url = await startLogin(loginDeps(c.get("requestId")), {
        platform: ADMIN_PLATFORM,
        locale: query.locale ?? c.get("locale"),
        // Unbound: the panel's code returns to its own https origin (ADR-027).
        codeChallenge: null,
      });
      return c.redirect(url.toString(), 302);
    } catch (error) {
      return whenFull(c, error);
    }
  });

  app.openapi(adminExchangeRoute, async (c) => {
    const { code } = c.req.valid("json");
    return c.json(await exchangeAdminCode(sessionDeps, code), 200);
  });

  for (const route of [adminWhoAmIRoute, adminLogoutRoute]) {
    app.use(route.getRoutingPath(), requireAnyStaff);
  }

  app.openapi(adminWhoAmIRoute, async (c) => {
    const staff = staffOf(c);
    return c.json({ role: staff.role, expiresAt: staff.expiresAt }, 200);
  });

  app.openapi(adminLogoutRoute, async (c) => {
    await endAdminSession(sessionDeps, staffOf(c).sessionId);
    return c.body(null, 204);
  });

  return app;
}
