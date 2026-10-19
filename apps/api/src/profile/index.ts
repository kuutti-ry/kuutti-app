// The profile slice's public surface (rules/layout.md): the routes, and the
// erasure and export halves the identity slice calls (#51). The card
// builder, which today's round (#96) serves its cards through, handed to the
// matching slice by app.ts.

// The card's age and fields, which a person's page in the panel shows as the card does (#306).
export { ageInYears, buildCard, fieldsOnCard } from "./card.ts";
export { completeness } from "./completeness.ts";
export { answeredPromptsOf } from "./repo.ts";
export { profileRoutes } from "./routes.ts";
export {
  eraseProfileOfAccount,
  exportProfile,
  readProfile,
  SPECIAL_CATEGORY_CONSENT_VERSION,
  saveProfile,
  withdrawSpecialCategoryAnswers,
} from "./service.ts";
// The plain-text rule for a message (#348, ADR-031 §3): the same refusal as the card's.
export { contactDetailsIn } from "./text.ts";
