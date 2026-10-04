// The profile slice's public surface (rules/layout.md): the routes, the card
// builder for the round builder of M4, the completeness rule for the tips of
// #56, and the erasure and export halves the identity slice calls (#51).

export {
  ageInYears,
  buildCard,
  type CardDeps,
  completenessOf,
  type PreferenceReader,
} from "./card.ts";
export { type CompletenessSnapshot, completeness } from "./completeness.ts";
export { answeredPromptsOf } from "./repo.ts";
export { profileRoutes } from "./routes.ts";
export { eraseProfileOfAccount, exportProfile } from "./service.ts";
export { type TipsSnapshot, tips } from "./tips.ts";
