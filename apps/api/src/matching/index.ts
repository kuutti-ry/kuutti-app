// Public surface of the matching slice in apps/api. Other slices import from here only.
// #46 brings the two hard rows of onboarding; #94 what they mean between two
// people; the rounds and their rules are the rest of M4.

// The round builder reads every person's deal-breakers as the person's own read does (#87).
export {
  type DealBreakerRow,
  dealBreakersFrom,
  pausedOf,
  readDealBreakers,
} from "./deal-breakers.ts";
export { bandBetween, inEachOthersPool, type PoolPerson, relaxedBy } from "./pool.ts";
export {
  CHANGE_CADENCE_KEY,
  deletePreferencesOfAccount,
  deleteSeeksOfAccount,
  nextChangeFrom,
  preferencesFrom,
  readPreferences,
  savePreferences,
} from "./preferences.ts";
// The round builder (#95, ADR-035) reads across slices and lives with the
// jobs; its order and its one writer are this slice's.
export {
  comingBackOrder,
  likedYouPlaces,
  mayMeet,
  type Return,
  type RoundCandidate,
  roundOrder,
} from "./round-order.ts";
export { roundRoutes } from "./round-routes.ts";
// The queue and the day's log of it (#96, #502, ADR-034, ADR-062): the routes,
// the one writer, and the halves erasure, the export and the night call.
export {
  addPlaces,
  eraseRoundsOf,
  exportRounds,
  type Place,
  pruneRounds,
  type Queue,
  type RelaxedCandidate,
  relaxationsOf,
} from "./rounds.ts";
export { preferencesRoutes } from "./routes.ts";
