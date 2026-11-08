// Public surface of the pond slice in apps/api (#46, #54, #94; TD-10). Other slices import from here only.

// The switch in the panel (#500, ADR-060 §2).
export { pondAdminRoutes } from "./admin-routes.ts";
export { readPondCounterK, readStandingFigures } from "./counter.ts";
// A person's one home (#514, ADR-061): the write, the reads, and what a kept place is.
export { exportHome, readHome, saveHome } from "./home.ts";
export {
  homeRules,
  homeSummary,
  keptPlace,
  pointOf,
  shownPlace,
} from "./places.ts";
export { findPondOfAccount, listPonds } from "./repo.ts";
export { pondRoutes } from "./routes.ts";
