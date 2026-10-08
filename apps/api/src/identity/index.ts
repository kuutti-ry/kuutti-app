// The identity slice's public surface (rules/layout.md). Discovery is what
// index.ts runs at boot (#32); the routes carry the login (#33) and the
// sessions (#35); the store is what the session middleware in lib/ reads through.

export { accountRoutes } from "./account-routes.ts";
export {
  ADMIN_SESSION_TTL_MS,
  adminSessionStore,
  sweepAdminSessions,
} from "./admin-session.ts";
export { BrokerError, type BrokerIdentity, type IdentityBroker } from "./broker.ts";
export { type ErasureSummary, eraseAccount, exportAccount } from "./erasure.ts";
export { wellKnownRoutes } from "./links.ts";
// hetu.ts stays inside the slice: nothing outside it may hold a hetu (rules/api.md).
export { brokerOptionsFromConfig, OidcBroker, teliaKeyIds } from "./oidc-broker.ts";
export {
  activationWaitsFor,
  CURRENT_CONSENT_VERSIONS,
  DEFAULT_POND_KEY,
  exportConsents,
  missingSteps,
  onboardingStatus,
  shownLocale,
} from "./onboarding.ts";
export { onboardingRoutes } from "./onboarding-routes.ts";
export {
  decideRegistration,
  REREGISTER_COOLDOWN_DAYS,
  type RegistrationDecision,
  recordDeletion,
} from "./registration.ts";
export { authRoutes } from "./routes.ts";
export { sessionStore } from "./session-store.ts";
export { sweepSessions } from "./sessions.ts";
