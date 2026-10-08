// Public surface of the matching slice in apps/api. Other slices import from here only.
// #46 brings the two hard rows of onboarding; #94 what they mean between two
// people; the rounds and their rules are the rest of M4.

export { inEachOthersPool, type PoolPerson, passesFiltersOf } from "./pool.ts";
export {
  CHANGE_CADENCE_KEY,
  deletePreferencesOfAccount,
  deleteSeeksOfAccount,
  nextChangeFrom,
  preferencesFrom,
  readPreferences,
  savePreferences,
} from "./preferences.ts";
export { preferencesRoutes } from "./routes.ts";
