// The identity slice's public surface (rules/layout.md). Discovery is what
// index.ts runs at boot (#32); the routes carry the login (#33) and the
// sessions (#35); the store is what the session middleware in lib/ reads through.

export { accountRoutes } from "./account-routes.ts";
export { adminSessionStore, sweepAdminSessions } from "./admin-session.ts";
// hetu.ts stays inside the slice: nothing outside it may hold a hetu (rules/api.md).
// The one registration without a bank is the demo job's (ADR-018 §2), from an
// artificial code only: the derivation refuses a code a person could have.
export {
  deriveArtificialIdentity,
  NotArtificialError,
  registerArtificial,
} from "./artificial.ts";
export type { IdentityBroker } from "./broker.ts";
export { type ErasureSummary, eraseAccount, exportAccount } from "./erasure.ts";
// The anonymous count of "Löysin hänet" (#83), for the panel's overview.
export { foundThemCounts } from "./found-them.ts";
export { hmacKeyFromHex } from "./hetu.ts";
export { wellKnownRoutes } from "./links.ts";
export { brokerOptionsFromConfig, OidcBroker, teliaKeyIds } from "./oidc-broker.ts";
export {
  CURRENT_CONSENT_VERSIONS,
  currentConsent,
  declareGender,
  giveConsent,
  onboardingStatus,
} from "./onboarding.ts";
export { onboardingRoutes } from "./onboarding-routes.ts";
export { decideRegistration, REREGISTER_COOLDOWN_DAYS } from "./registration.ts";
// Read-only: what the callback would find for a hash (the demo's tests ask so).
export { findIdentityByHmac, findLiveAccount } from "./repo.ts";
// The app-wide address limit refuses a start the way the doors do (ADR-026 §4).
export { authRoutes, isSignInStart, refuseSignInStart } from "./routes.ts";
export { sessionStore } from "./session-store.ts";
export { sweepSessions } from "./sessions.ts";
// A person's page in the panel (#306): the account and the identity's standing, for staff.
export { accountForStaff } from "./staff-view.ts";
// The account's state and the identity's standing, settled from the open
// sanctions the safety slice counts (#307, ADR-024 §2); the sessions a
// suspension or a ban ends.
export {
  endSessionsForSanction,
  lockAccountForSanction,
  type OpenSanctions,
  settleStanding,
} from "./standing.ts";
