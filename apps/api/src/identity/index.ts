// The identity slice's public surface (rules/layout.md). Discovery is what
// index.ts runs at boot (#32); the routes carry the login (#33) and the
// sessions (#35); the store is what the session middleware in lib/ reads through.

export { accountRoutes } from "./account-routes.ts";
export {
  ADMIN_SESSION_TTL_MS,
  adminSessionStore,
  sweepAdminSessions,
} from "./admin-session.ts";
// hetu.ts stays inside the slice: nothing outside it may hold a hetu (rules/api.md).
// The one registration without a bank is the demo job's (ADR-018 §2), from an
// artificial code only: the derivation refuses a code a person could have.
export {
  type ArtificialRegistration,
  deriveArtificialIdentity,
  NotArtificialError,
  registerArtificial,
} from "./artificial.ts";
export { BrokerError, type BrokerIdentity, type IdentityBroker } from "./broker.ts";
export { type ErasureSummary, eraseAccount, exportAccount } from "./erasure.ts";
export { hmacKeyFromHex } from "./hetu.ts";
export { wellKnownRoutes } from "./links.ts";
export { brokerOptionsFromConfig, OidcBroker, teliaKeyIds } from "./oidc-broker.ts";
export {
  activationWaitsFor,
  CURRENT_CONSENT_VERSIONS,
  currentConsent,
  DEFAULT_POND_KEY,
  declareGender,
  exportConsents,
  giveConsent,
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
// Read-only: what the callback would find for a hash (the demo's tests ask so).
export { findIdentityByHmac, findLiveAccount } from "./repo.ts";
export { authRoutes } from "./routes.ts";
export { sessionStore } from "./session-store.ts";
export { sweepSessions } from "./sessions.ts";
