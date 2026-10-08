// Public surface of the pond slice in apps/api (#46, #54, #94; TD-10). Other slices import from here only.

export {
  type Admission,
  type Applicant,
  admissionAnew,
  admit,
  admitsAlone,
  competeAlike,
  contestsOf,
  type Declared,
  deleteGateOfAccount,
  exportGate,
  GATE_EMPTIED,
  type GateRow,
  joinsAContest,
  neededFrom,
  placeAlone,
  readGateRow,
  saidInStep,
  sayPlace,
  sayPool,
} from "./gate.ts";
export { findPondBySlug, findPondOfAccount, listPonds, setPondOfAccount } from "./repo.ts";
export { type GateReader, pondRoutes } from "./routes.ts";
export {
  readStandingFigures,
  readWaitlist,
  readWaitlistK,
  type StandingFigures,
  WAITLIST_K_KEY,
} from "./waitlist.ts";
