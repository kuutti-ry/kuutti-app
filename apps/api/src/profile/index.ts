// The profile slice's public surface (rules/layout.md): the routes, the card
// builder for the round builder of M4, the completeness rule for the tips of
// #56, and the erasure and export halves the identity slice calls (#51).

export {
  ageInYears,
  buildCard,
  type CardDeps,
  completenessOf,
  fieldsOnCard,
  type PreferenceReader,
  sharedAnswers,
} from "./card.ts";
export { type CompletenessSnapshot, completeness } from "./completeness.ts";
export { answeredPromptsOf } from "./repo.ts";
export { profileRoutes } from "./routes.ts";
export {
  eraseProfileOfAccount,
  exportProfile,
  readProfile,
  SPECIAL_CATEGORY_CONSENT_VERSION,
  withdrawSpecialCategoryAnswers,
} from "./service.ts";
