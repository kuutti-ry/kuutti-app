// Public surface of the research slice in apps/api (#50, TD-5, ADR-011).
// Other slices import from here only: identity for the mapping row's life
// (consent given, withdrawn, erased) and the export; any slice for track().

export { researchAnonymityJob } from "./anonymity.ts";
export { copiedBeforeDrop, researchCopyJob } from "./copy.ts";
export { s3CopyStore } from "./copy-store.ts";
export { exportResearch } from "./export.ts";
export { ensureEventPartitions, researchEventsJob } from "./partitions.ts";
export {
  enrolSubject as enrolResearchSubject,
  removeSubject as removeResearchSubject,
} from "./repo.ts";
export { track } from "./track.ts";
