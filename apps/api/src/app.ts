import { OpenAPIHono } from "@hono/zod-openapi";
import type { Queryable } from "@kuutti/db";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { healthRoutes } from "./health/index.ts";
import {
  accountRoutes,
  adminSessionStore,
  authRoutes,
  type IdentityBroker,
  onboardingRoutes,
  sessionStore,
  wellKnownRoutes,
} from "./identity/index.ts";
import { gateOf } from "./jobs/pond-gate.ts";
import { requireAdmin } from "./lib/admin-middleware.ts";
import { requireSession } from "./lib/auth-middleware.ts";
import type { Config } from "./lib/config.ts";
import { corsAllowlist } from "./lib/cors.ts";
import type { AppEnv } from "./lib/env.ts";
import {
  type ErrorReporter,
  localisedEnvelope,
  notFound,
  onError,
  validationHook,
} from "./lib/errors.ts";
import { requestLocale, servedLocales } from "./lib/i18n.ts";
import { type Logger, requestLogger } from "./lib/logger.ts";
import { openApiDocument } from "./lib/openapi.ts";
import { rateLimit } from "./lib/rate-limit.ts";
import { serverRequestId } from "./lib/request-id.ts";
import { preferencesRoutes } from "./matching/index.ts";
import { type MediaDeps, photoAdminRoutes, photoRoutes, UPLOAD_ROUTE } from "./media/index.ts";
import { pondRoutes } from "./pond/index.ts";
import { exportProfile, profileRoutes } from "./profile/index.ts";

export type { AppEnv };

/** Everything a request handler may reach. Injected, so tests hand in a transaction. */
export type Deps = {
  config: Config;
  logger: Logger;
  db: Queryable;
  /** Unhandled-error sink (#11); absent in tests and local runs. */
  report?: ErrorReporter;
  /** The bank-login broker (#33); absent when OIDC is not configured, and the auth routes answer 503. */
  broker?: IdentityBroker;
  /** Object storage and URL signing (#48); absent when neither is configured, and the photo routes answer 503. */
  media?: MediaDeps;
};

const UNLIMITED_PATHS = new Set(["/health", "/openapi.json"]);

/** Routes that answer without a session: the health probe, the contract, and the login itself. */
export const PUBLIC_ROUTES = new Set([
  "GET /health",
  "GET /openapi.json",
  // Aggregates per pond, once a day, nothing below k (#54, ADR-013).
  "GET /waitlist",
  "GET /auth/start",
  "GET /auth/callback",
  "POST /auth/exchange",
  "POST /auth/refresh",
  "GET /.well-known/assetlinks.json",
  "GET /.well-known/apple-app-site-association",
  "GET /admin/auth/start",
  "POST /admin/auth/exchange",
]);

export function createApp(deps: Deps) {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook<AppEnv>(deps.logger) });

  // Order matters: id first so every later line carries it, logging next so
  // even rejected requests are logged, then the protections, then routes.
  app.use("*", serverRequestId());
  // Before everything that may answer, so a refusal speaks the request's language (#13).
  // What this environment serves: the released languages only in production (#55).
  app.use("*", requestLocale(servedLocales(deps.config.APP_ENV)));
  app.use("*", requestLogger(deps.logger, { trustedProxy: deps.config.TRUSTED_PROXY }));
  app.use("*", secureHeaders());
  // No environment of this API is a web surface (rule 8); previews have public
  // URLs that a crawler may still find (#9).
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Robots-Tag", "noindex, nofollow");
  });
  app.use("*", corsAllowlist(deps.config.corsAllowedOrigins));
  // The photo upload is the one body allowed past the app-wide cap; its own
  // 10 MB limit sits on the route, behind the session guard (media/routes.ts).
  const limitBody = bodyLimit({
    maxSize: deps.config.BODY_LIMIT_BYTES,
    onError: (c) => c.json(localisedEnvelope(c, "payload_too_large"), 413),
  });
  app.use("*", (c, next) =>
    c.req.method === UPLOAD_ROUTE.method && c.req.path === UPLOAD_ROUTE.path
      ? next()
      : limitBody(c, next),
  );
  app.use(
    "*",
    rateLimit({
      limit: deps.config.RATE_LIMIT_PER_MINUTE,
      windowMs: 60_000,
      trustedProxy: deps.config.TRUSTED_PROXY,
      skip: (path) => UNLIMITED_PATHS.has(path),
    }),
  );

  app.onError(onError<AppEnv>(deps.logger, deps.report));
  app.notFound(notFound<AppEnv>());

  // One guard for every route that reads user data (rule 6), and one for
  // staff (#49, checklist line 10) with the roles a route admits; app.test.ts
  // checks that no route outside PUBLIC_ROUTES is registered without one.
  const guard = requireSession({ db: deps.db, store: sessionStore });
  const anyStaff = requireAdmin({
    db: deps.db,
    store: adminSessionStore,
    roles: ["moderator", "admin", "researcher"],
  });
  const moderators = requireAdmin({
    db: deps.db,
    store: adminSessionStore,
    roles: ["moderator", "admin"],
  });

  app.route("/", healthRoutes(deps));
  app.route("/", authRoutes(deps, guard, anyStaff));
  app.route("/", accountRoutes(deps, guard));
  app.route("/", wellKnownRoutes(deps));
  app.route("/", photoRoutes(deps, guard));
  app.route("/", photoAdminRoutes(deps, moderators));
  app.route("/", profileRoutes(deps, guard));
  app.route("/", onboardingRoutes(deps, guard));
  // The gate's count reads across slices and lives with the jobs; the pond's route is handed it.
  app.route(
    "/",
    pondRoutes(deps, guard, (accountId) =>
      gateOf({ db: deps.db, logger: deps.logger, now: () => new Date() }, accountId),
    ),
  );
  // The deal-breakers need the caller's own answers (#149): the profile slice reads them, handed in here.
  app.route(
    "/",
    preferencesRoutes(
      deps,
      guard,
      async (accountId) => (await exportProfile(deps.db, accountId))?.fields ?? {},
    ),
  );

  // The bearer scheme the session routes declare (#35); the tokens themselves
  // are opaque, so the scheme is all the contract says about them.
  app.openAPIRegistry.registerComponent("securitySchemes", "session", {
    type: "http",
    scheme: "bearer",
    description: "The access token from /auth/exchange or /auth/refresh.",
  });
  if (deps.config.APP_ENV !== "production") {
    app.doc("/openapi.json", openApiDocument(deps.config.APP_VERSION));
  }

  return app;
}

export type App = ReturnType<typeof createApp>;

// Preview check for #9 (d): this comment is the throwaway change and never merges.
