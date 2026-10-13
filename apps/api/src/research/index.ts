// Public surface of the research slice in apps/api (#50, TD-5, ADR-011).
// Other slices import from here only: identity for the mapping row's life
// (consent given, withdrawn, erased) and the export; any slice for track().

export { anonymityCensus, researchAnonymityJob } from "./anonymity.ts";
export { exportResearch } from "./export.ts";
export {
  EVENTS_RETENTION_DAYS,
  ensureEventPartitions,
  pruneEventPartitions,
  researchEventsJob,
} from "./partitions.ts";
export {
  enrolSubject as enrolResearchSubject,
  removeSubject as removeResearchSubject,
} from "./repo.ts";
export { type ResearchDeps, type TrackResult, track } from "./track.ts";
