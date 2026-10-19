// The media slice's public surface (rules/layout.md). The routes carry the
// photo pipeline (#48) and the moderation queue (#49); the deps are what
// index.ts wires at boot from the configuration and what tests hand in with a
// memory store.

export { photoAdminRoutes } from "./admin-routes.ts";
export { dayWindow, localYearMonth, secondsUntil } from "./budget.ts";
export {
  deleteOrphanedObjects,
  EXPORT_MESSAGE_PHOTOS_MAX,
  type ExportedPhotoFile,
  erasePhotosOfAccount,
  eraseReleasedPhotos,
  exportPhotos,
  type PhotoErasure,
} from "./erasure.ts";
export { type Inspection, type Moderator, sweepPendingPhotos } from "./moderation.ts";
export {
  countMessagePhotosSince,
  issueConversationThumb,
  issueMessagePhotoUrls,
  type MediaDeps,
  type PreparedMessagePhoto,
  prepareMessagePhoto,
  storeMessagePhoto,
  uploadPhoto,
} from "./photos.ts";
export {
  listApprovedPhotos,
  listPhotos,
  queueSummary,
  recordCardServed,
  wasShown,
} from "./repo.ts";
export { photoRoutes, UPLOAD_ROUTE } from "./routes.ts";
export { type MediaStore, memoryMediaStore, objectKey } from "./store.ts";
export { cloudFrontSigner, staffPhotoUrl } from "./urls.ts";
export { createMediaDeps } from "./wiring.ts";
