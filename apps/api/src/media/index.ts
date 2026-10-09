// The media slice's public surface (rules/layout.md). The routes carry the
// photo pipeline (#48) and the moderation queue (#49); the deps are what
// index.ts wires at boot from the configuration and what tests hand in with a
// memory store.

export { photoAdminRoutes } from "./admin-routes.ts";
export { dayWindow, localYearMonth, secondsUntil } from "./budget.ts";
export {
  deleteOrphanedObjects,
  erasePhotosOfAccount,
  exportPhotos,
  type PhotoErasure,
} from "./erasure.ts";
export {
  decideModeration,
  type Inspection,
  type Moderator,
  queueAllModerator,
  sweepPendingPhotos,
} from "./moderation.ts";
export {
  type MediaDeps,
  type PhotoServiceDeps,
  RETRY_AFTER_SECONDS,
  uploadPhoto,
} from "./photos.ts";
export { type CardServed, listApprovedPhotos, listPhotos, recordCardServed } from "./repo.ts";
export { photoRoutes, UPLOAD_ROUTE } from "./routes.ts";
export { type MediaStore, memoryMediaStore, objectKey, s3MediaStore } from "./store.ts";
export { cloudFrontSigner, presignedS3Signer, URL_TTL_MS, type UrlSigner } from "./urls.ts";
export { createMediaDeps, type MediaSetup } from "./wiring.ts";
