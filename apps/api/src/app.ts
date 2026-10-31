import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Queryable } from "@kuutti/db";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import {
  chatRoutes,
  chatSocketRoutes,
  conversationBetween,
  createLive,
  type Live,
  messageReaders,
  openConversation,
  PHOTO_MESSAGE_PATH,
} from "./chat/index.ts";
import { healthRoutes } from "./health/index.ts";
import {
  accountRoutes,
  adminSessionStore,
  authRoutes,
  currentConsent,
  type IdentityBroker,
  isSignInStart,
  onboardingRoutes,
  refuseSignInStart,
  sessionStore,
  wellKnownRoutes,
} from "./identity/index.ts";
import { isComplete, matchingStatusOf } from "./jobs/pool.ts";
import { buildRoundOf, relaxationOffers, relaxedCandidates } from "./jobs/round-builder.ts";
import { requireAdmin } from "./lib/admin-middleware.ts";
import { requireSession } from "./lib/auth-middleware.ts";
import type { Config } from "./lib/config.ts";
import { corsAllowlist } from "./lib/cors.ts";
import type { AppEnv } from "./lib/env.ts";
import {
  AppError,
  type ErrorReporter,
  localisedEnvelope,
  notFound,
  onError,
  validationHook,
} from "./lib/errors.ts";
import { requestLocale, servedLocales } from "./lib/i18n.ts";
import { type Logger, requestLogger } from "./lib/logger.ts";
import type { Mailer } from "./lib/mail.ts";
import { servedDocument } from "./lib/openapi.ts";
import type { Pusher } from "./lib/push.ts";
import { addressOf, limited, personOf, rateLimit } from "./lib/rate-limit.ts";
import { serverRequestId } from "./lib/request-id.ts";
import { preferencesRoutes, readPreferences, roundRoutes } from "./matching/index.ts";
import { type MediaDeps, photoAdminRoutes, photoRoutes, UPLOAD_ROUTE } from "./media/index.ts";
import { createPush, notificationRoutes, type Push } from "./notifications/index.ts";
import { pondAdminRoutes, pondRoutes } from "./pond/index.ts";
import { buildCard, exportProfile, profileRoutes } from "./profile/index.ts";
import { invitationRoutes } from "./rewards/index.ts";
import {
  accountAdminRoutes,
  auditAdminRoutes,
  checkFirstMessage,
  checkPhotoFetches,
  configAdminRoutes,
  feedbackAdminRoutes,
  feedbackRoutes,
  overviewAdminRoutes,
  reportAdminRoutes,
  reportRoutes,
  roundReadRule,
  sanctionAdminRoutes,
  staffAdminRoutes,
} from "./safety/index.ts";

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
  /** The photo routes' clock, which the fifteen minutes of a signed URL count from (#48); the wall clock when absent. Tests fix it. */
  now?: () => Date;
  /** The chat's live sockets (#349): boot hands in the one its listener feeds; absent, the app makes its own. */
  live?: Live;
  /** Mail out (#385, ADR-043): SES or the development log; absent where MAIL is off, and a code answers 503. */
  mailer?: Mailer;
  /** Push out (#102, ADR-055): Expo or the development log; absent where PUSH is off, and nothing is sent. */
  pusher?: Pusher;
  /** The pushes (#102): boot hands in the process's one, which its shutdown waits for; absent, the app makes its own over `pusher`. */
  push?: Push;
};

const UNLIMITED_PATHS = new Set(["/health", "/openapi.json"]);

/**
 * The routes that end a session or the account (ADR-026 §2): outside the
 * person's budget, so somebody holding one stolen session cannot spend it to
 * keep the owner from signing every device out, pausing or deleting; and
 * never given back to the address, so they stay under the address's limit.
 */
export const ENDS_SESSION = new Set([
  "/auth/logout",
  "/auth/logout-all",
  "/admin/auth/logout",
  "/account/delete",
  "/account/pause",
]);

/** Routes that answer without a session: the health probe, the contract, and the login itself. */
export const PUBLIC_ROUTES = new Set([
  "GET /health",
  "GET /openapi.json",
  "GET /docs",
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
  // The chat's socket (#349): its first frame carries the session's token, checked
  // by the guard's own code (authenticate), so the token never sits in a URL.
  "GET /ws",
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
  // The two photo uploads are the bodies allowed past the app-wide cap: a
  // profile photo and a photo sent in a conversation (#350). Each has its own
  // 10 MB limit on its route, behind the session guard (media/routes.ts,
  // chat/routes.ts).
  const limitBody = bodyLimit({
    maxSize: deps.config.BODY_LIMIT_BYTES,
    onError: (c) => c.json(localisedEnvelope(c, "payload_too_large"), 413),
  });
  app.use("*", (c, next) =>
    c.req.method === UPLOAD_ROUTE.method &&
    (c.req.path === UPLOAD_ROUTE.path || PHOTO_MESSAGE_PATH.test(c.req.path))
      ? next()
      : limitBody(c, next),
  );
  // Counted by the client address while nobody is known yet; a request a
  // guard admits is given back to the address and counted by its person
  // instead, so people behind one address do not spend each other's budget,
  // while a token that opens no session stays on the address (ADR-026 §1-2).
  // A sign-in start it refuses goes back as the doors send one (§4).
  app.use(
    "*",
    rateLimit({
      limit: deps.config.RATE_LIMIT_PER_MINUTE,
      windowMs: 60_000,
      keyOf: addressOf(deps.config.TRUSTED_PROXY),
      // Given back only for a request the person's limiter counted: a guard
      // without it, or a session-ending route it skips, stays on the address.
      refund: (c) => c.get("personCounted") === true,
      refuse: (c, retryAfterSeconds) =>
        isSignInStart(c.req.path)
          ? refuseSignInStart(c, deps, "address")
          : limited(c, retryAfterSeconds),
      skip: (path) => UNLIMITED_PATHS.has(path),
    }),
  );

  app.onError(onError<AppEnv>(deps.logger, deps.report));
  app.notFound(notFound<AppEnv>());

  // One guard for every route that reads user data (rule 6), and one for
  // staff (#49, checklist line 10) with the roles a route admits; app.test.ts
  // checks that no route outside PUBLIC_ROUTES is registered without one.
  // Every guard hands the request it admits to one limiter keyed by the
  // person, so a member of staff has one budget, not one per role check
  // (ADR-026 §3); the routes that end a session stay outside it (§2).
  const perPerson = rateLimit({
    limit: deps.config.RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
    keyOf: personOf,
    skip: (path) => ENDS_SESSION.has(path),
    onCount: (c) => c.set("personCounted", true),
  });
  const guard = requireSession({ db: deps.db, store: sessionStore, limit: perPerson });
  const anyStaff = requireAdmin({
    db: deps.db,
    store: adminSessionStore,
    roles: ["moderator", "admin", "researcher"],
    limit: perPerson,
  });
  const moderators = requireAdmin({
    db: deps.db,
    store: adminSessionStore,
    roles: ["moderator", "admin"],
    limit: perPerson,
  });
  // A ban and its lift and review (#307, ADR-024 §3).
  const admins = requireAdmin({
    db: deps.db,
    store: adminSessionStore,
    roles: ["admin"],
    limit: perPerson,
  });

  // The automatic rules' clock and connection (#105, ADR-033), and the round
  // reads one of them counts in memory, once for this app (#86, ADR-041).
  const ruleDeps = { db: deps.db, logger: deps.logger, now: deps.now ?? (() => new Date()) };
  const roundRead = roundReadRule(ruleDeps);

  app.route("/", healthRoutes(deps));
  app.route("/", authRoutes(deps, guard, anyStaff));
  app.route("/", accountRoutes(deps, guard));
  app.route("/", wellKnownRoutes(deps));
  // A URL of somebody else's photo is checked by the velocity rule (#86,
  // ADR-041): the safety slice decides, the media slice only issues.
  app.route(
    "/",
    photoRoutes(deps, guard, (accountId) => checkPhotoFetches(ruleDeps, accountId)),
  );
  app.route("/", photoAdminRoutes(deps, moderators));
  app.route("/", profileRoutes(deps, guard));
  app.route("/", onboardingRoutes(deps, guard));
  app.route("/", feedbackRoutes(deps, guard));
  app.route("/", feedbackAdminRoutes(deps, moderators));
  app.route("/", reportRoutes(deps, guard));
  // What a person chose to be notified of, and the notices in the app (#176, ADR-032).
  app.route("/", notificationRoutes(deps, guard));
  // Invitations and the reward they earn (#107, ADR-044).
  app.route(
    "/",
    invitationRoutes(deps, guard, (db, accountId) =>
      isComplete(db, accountId, deps.now?.() ?? new Date()),
    ),
  );
  // The chat's live sockets (#349): who is in the app now, which the push asks too.
  const live =
    deps.live ??
    createLive({
      db: deps.db,
      logger: deps.logger,
      socketsPerAccount: deps.config.WS_SOCKETS_PER_ACCOUNT,
    });
  // The pushes (#102, ADR-055): the notifications slice decides whom to tell,
  // the chat and the round's routes only say when.
  const push =
    deps.push ??
    createPush({
      db: deps.db,
      logger: deps.logger,
      now: deps.now ?? (() => new Date()),
      ...(deps.pusher ? { pusher: deps.pusher } : {}),
      online: (accountId) => live.online(accountId),
    });
  // The conversations a match opens and their text messages (#348, ADR-031).
  // A conversation's first message is checked by the automatic rules (#105,
  // ADR-033): the safety slice decides, the chat only measures. Every new
  // message is handed to the push with whom the chat lets read it.
  app.route(
    "/",
    chatRoutes(
      deps,
      guard,
      (accountId, conversationId) => checkFirstMessage(ruleDeps, { accountId, conversationId }),
      (accountId, conversationId, seq) =>
        push.message({
          conversationId,
          readers: () =>
            messageReaders(deps.db, { conversationId, seq, senderAccountId: accountId }),
        }),
    ),
  );
  // ...and what changes in them, live over one socket (#349, ADR-031 §5).
  app.route(
    "/",
    chatSocketRoutes({
      db: deps.db,
      logger: deps.logger,
      store: sessionStore,
      live,
      now: deps.now ?? (() => new Date()),
      allowedOrigins: deps.config.corsAllowedOrigins,
      timing: {
        authMs: deps.config.WS_AUTH_TIMEOUT_MS,
        pingMs: deps.config.WS_PING_INTERVAL_MS,
        pongMs: deps.config.WS_PONG_TIMEOUT_MS,
      },
    }),
  );
  app.route("/", sanctionAdminRoutes(deps, moderators, admins));
  app.route("/", configAdminRoutes(deps, admins));
  app.route("/", overviewAdminRoutes(deps, moderators));
  app.route("/", reportAdminRoutes(deps, moderators));
  app.route("/", accountAdminRoutes(deps, moderators));
  app.route("/", auditAdminRoutes(deps, admins));
  app.route("/", staffAdminRoutes(deps, admins));
  app.route("/", pondAdminRoutes(deps, admins));
  // Completeness reads across slices and lives with the jobs; the pond's route is handed it.
  app.route(
    "/",
    pondRoutes(deps, guard, (accountId) =>
      matchingStatusOf({ db: deps.db, now: deps.now ?? (() => new Date()) }, accountId),
    ),
  );
  const builderDeps = () => ({
    db: deps.db,
    logger: deps.logger,
    now: () => deps.now?.() ?? new Date(),
  });
  // The caller's own answers, which the deal-breakers' pause and the cards' "did not answer" read (#149, #99).
  const ownFieldsOf = async (accountId: string) =>
    (await exportProfile(deps.db, accountId))?.fields ?? {};
  // Today's round (#96, ADR-034) serves its cards through the profile slice's
  // builder, handed in here since profile already imports matching; a card
  // the builder refuses (404) is a card the round leaves out, and its budget's
  // 429 goes through. A day's first read with no round builds it through the
  // round builder, which reads across slices and lives with the jobs (#95).
  // A read is checked by the velocity rules after it (#86, ADR-041).
  app.route(
    "/",
    roundRoutes(
      deps,
      guard,
      async (viewerAccountId, subjectAccountId) => {
        try {
          const built = await buildCard(
            {
              db: deps.db,
              logger: deps.logger,
              now: deps.now ?? (() => new Date()),
              readPreferences,
            },
            { viewerAccountId, subjectAccountId },
          );
          return built.card;
        } catch (error) {
          if (error instanceof AppError && error.status === 404) return null;
          throw error;
        }
      },
      // shortcut: nothing is built in production until the maintainer has set how long
      // rounds are kept (ADR-034 Open 2, ADR-035 Open 1); his answer lifts this and boot.ts's twin.
      deps.config.APP_ENV === "production"
        ? async () => false
        : (accountId) => buildRoundOf(builderDeps(), accountId),
      // A match is a conversation (#100, ADR-031): the chat slice's, handed in
      // here since the chat imports the profile, which imports matching.
      { between: conversationBetween, open: openConversation, made: push.match },
      roundRead,
      // A short round's relaxations (#99, ADR-042) read the pond as the builder does.
      {
        offers: (accountId) => relaxationOffers(builderDeps(), accountId),
        candidates: (accountId, relaxation) =>
          relaxedCandidates(builderDeps(), accountId, relaxation),
      },
      ownFieldsOf,
    ),
  );
  // The deal-breakers need the caller's own answers (#149): the profile slice reads them, handed in here.
  app.route(
    "/",
    preferencesRoutes(
      deps,
      guard,
      ownFieldsOf,
      // Whom one seeks waits for the identity slice's consent row (ADR-019 §4, ADR-010 §16).
      async (tx, accountId) => (await currentConsent(tx, accountId, "special_category")) !== null,
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
    app.get("/openapi.json", (c) => c.json(servedDocument(app, deps.config.APP_VERSION)));
  }
  // Swagger UI over the same document, on a developer's machine only: the page
  // pulls swagger-ui-dist from jsDelivr, and no deployed environment of this
  // API is a web surface (rule 8). Staging and previews keep /openapi.json alone.
  if (deps.config.APP_ENV === "development" || deps.config.APP_ENV === "test") {
    app.get("/docs", swaggerUI({ url: "/openapi.json", version: "5.33.1", title: "Kuutti API" }));
  }

  return app;
}

export type App = ReturnType<typeof createApp>;
