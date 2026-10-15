// The profile slice's public surface (rules/layout.md): the routes, and the
// erasure and export halves the identity slice calls (#51). The card builder
// joins the surface when the round builder of M4 needs it (#276).

export { ageInYears } from "./card.ts";
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
