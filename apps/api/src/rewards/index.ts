// The rewards slice's public surface in apps/api (#107, ADR-044; TD-15). Other slices import from here only.

// The invitations: the routes, the night's count (wired in jobs/), and the
// halves erasure and the export call (ADR-007 §4).
export {
  countInvitations,
  eraseInvitationsOf,
  exportInvitations,
  type RewardsDeps,
} from "./invitations.ts";
// The ledger as matching's decide spends it and gives it back, and as the
// round says whether a fish can go (ADR-044 §8, #475).
export { earnedFishWaiting, entriesPaidBy, releaseEarned, spendEarned } from "./ledger.ts";
export { invitationRoutes } from "./routes.ts";
