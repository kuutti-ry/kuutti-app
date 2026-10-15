// The media slice's public surface (rules/layout.md). The routes carry the
// photo pipeline (#48) and the moderation queue (#49); the deps are what
// index.ts wires at boot from the configuration and what tests hand in with a
// memory store.

export { photoAdminRoutes } from "./admin-routes.ts";
export { dayWindow, localYearMonth, secondsUntil } from "./budget.ts";
export {
  deleteOrphanedObjects,
  type ExportedPhotoFile,
  erasePhotosOfAccount,
  exportPhotos,
  type PhotoErasure,
} from "./erasure.ts";
export { sweepPendingPhotos } from "./moderation.ts";
export { type MediaDeps, uploadPhoto } from "./photos.ts";
export {
  listApprovedPhotos,
  listPhotos,
  recordCardServed,
} from "./repo.ts";
export { photoRoutes, UPLOAD_ROUTE } from "./routes.ts";
export { memoryMediaStore, objectKey } from "./store.ts";
export { cloudFrontSigner } from "./urls.ts";
export { createMediaDeps } from "./wiring.ts";
