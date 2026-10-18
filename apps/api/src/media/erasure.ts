import type { Queryable } from "@kuutti/db";
import {
  type ExportedPhoto,
  type ExportedPhotoReview,
  type ExportedSentPhoto,
  PHOTO_VARIANTS,
} from "@kuutti/schema";
import type { Logger } from "../lib/logger.ts";
import { type PhotoServiceDeps, toPhoto } from "./photos.ts";
import * as repo from "./repo.ts";
import { type MediaStore, objectKey } from "./store.ts";

// The media slice's half of erasure and export (#51, TD-7), called by the
// identity slice through index.ts. Rows go inside the caller's transaction;
// objects go after it, because an object store has no rollback.

export type PhotoErasure = {
  photos: number;
  accessRows: number;
  /** Cards shown to the person (#52); the rows about their own photos went with the photos. */
  shownRows: number;
  /** Content keys of the deleted rows; which of their objects still have an owner is decided after the commit. */
  keys: string[];
};

/**
 * The person's photos, every purpose, their fetch log and the cards shown to
 * them, in the caller's transaction. `keep` names photos that outlive the
 * erasure: #351 fills it with the photos a report's frozen copy holds for its
 * twelve months; nothing does yet (#350). A message photo that goes leaves
 * its message reading "Photo removed" (message.photo_id on delete set null).
 */
export async function erasePhotosOfAccount(
  tx: Queryable,
  accountId: string,
  keep: readonly string[] = [],
): Promise<PhotoErasure> {
  const keys = await repo.deletePhotosOfAccount(tx, accountId, keep);
  const accessRows = await repo.deletePhotoAccessOfAccount(tx, accountId);
  const shownRows = await repo.deleteCardShownOfAccount(tx, accountId);
  return { photos: keys.length, accessRows, shownRows, keys };
}

/**
 * After the commit: the objects of the content keys no row references any
 * more. The ownership check runs here, against committed rows, not inside the
 * transaction, so an upload of the same content that committed meanwhile
 * keeps its objects. What remains is the window between this check and the
 * delete, the same one the upload's failure path and deletePhoto have had
 * since #57: closing it takes a per-content-key ownership protocol in the
 * media slice, noted for the M4 orphan sweep. Best effort: a failure is
 * logged with the content keys (SHA-256 of the WebP bytes, nothing personal)
 * and the account; the rows are already gone.
 */
export async function deleteOrphanedObjects(
  deps: { db: Queryable; store: MediaStore; logger: Logger },
  keys: string[],
  context: { accountId: string },
): Promise<number> {
  if (keys.length === 0) return 0;
  let objectKeys: string[] = [];
  try {
    const orphaned = await repo.orphanedKeys(deps.db, keys);
    objectKeys = orphaned.flatMap((key) =>
      PHOTO_VARIANTS.map((variant) => objectKey(key, variant)),
    );
    if (objectKeys.length === 0) return 0;
    await deps.store.delete(objectKeys);
    return objectKeys.length;
  } catch (error) {
    deps.logger.error(
      { err: error, accountId: context.accountId, keys, objects: objectKeys.length },
      "erasure: deleting photo objects failed",
    );
    return 0;
  }
}

const EXPORT_ACCESS_LOG_LIMIT = 1000;
/** The photos sent in conversations whose files an export carries, the newest first (#350). */
export const EXPORT_MESSAGE_PHOTOS_MAX = 100;

/** One photo's file for the zip (#237): where the document points, and the bytes as stored. */
export type ExportedPhotoFile = { path: string; bytes: Uint8Array };

/** `photos/<photo id>.webp`: the full variant, 1600 px on the long edge, the best Kuutti holds (rule 4). */
const exportedPhotoPath = (photoId: string): string => `photos/${photoId}.webp`;

/**
 * The person's photos for the export: what the list shows, the moderation
 * outcome (never the labels), and the full-size file of each photo whose
 * object the store still holds, rejected and queued ones too (#237: they are
 * data Kuutti holds). Each read is logged as a fetch of the full variant, so
 * the export appears in the fetch log it returns, and never refused: the
 * day's copies are capped by the identity slice. With them, the cards served
 * to the person (ADR-008): the trail that erasure deletes is theirs to read first.
 */
export async function exportPhotos(
  deps:
    | PhotoServiceDeps
    | (Omit<PhotoServiceDeps, "store" | "signer" | "limit" | "moderator"> & { media?: undefined }),
  accountId: string,
): Promise<{
  /** Less the description in words (#296), which the identity slice adds in the request's language. */
  photos: Array<Omit<ExportedPhoto, "descriptionText">>;
  files: ExportedPhotoFile[];
  accessLog: Array<{ photoId: string; variant: (typeof PHOTO_VARIANTS)[number]; at: string }>;
  cardsShown: Array<{ photoId: string; at: string }>;
  /** The photos sent in conversations (#350), by id, for their lines; less the words, as above. */
  sent: Map<string, Omit<ExportedSentPhoto, "descriptionText">>;
}> {
  const rows = await repo.listPhotos(deps.db, accountId);
  const reviews = await repo.listReviewsForAccount(deps.db, accountId);
  const store = "store" in deps ? deps.store : null;
  const photos: Array<Omit<ExportedPhoto, "descriptionText">> = [];
  const files: ExportedPhotoFile[] = [];
  for (const row of rows) {
    let file: string | null = null;
    // Two rows may share one object (the same picture uploaded twice): each
    // row gets its own file, named by the row's id.
    const bytes = store ? await store.get(objectKey(row.key, "full")) : null;
    if (bytes) {
      file = exportedPhotoPath(row.id);
      files.push({ path: file, bytes });
      await repo.logPhotoAccess(deps.db, {
        accountId,
        photoId: row.id,
        variant: "full",
        at: deps.now(),
      });
    }
    const review = reviews.get(row.id);
    photos.push({ ...toPhoto(row), file, review: review ? exportedReview(review) : null });
  }
  // The photos the person sent in conversations (#350), for their lines:
  // each one's outcome and description, as a profile photo's, and its file,
  // logged as any read is (with the purpose `message`, never counted).
  // shortcut: files for the newest EXPORT_MESSAGE_PHOTOS_MAX only, since the
  // zip is built in memory (ADR-007 §3) and ten a day add up; the rest say
  // no file. A zip streamed to the response lifts it.
  const sent = new Map<string, Omit<ExportedSentPhoto, "descriptionText">>();
  for (const photo of await repo.listMessagePhotosOfAccount(deps.db, accountId)) {
    const bytes =
      store && sent.size < EXPORT_MESSAGE_PHOTOS_MAX
        ? await store.get(objectKey(photo.key, "full"))
        : null;
    let file: string | null = null;
    if (bytes) {
      file = exportedPhotoPath(photo.id);
      files.push({ path: file, bytes });
      await repo.logPhotoAccess(deps.db, {
        accountId,
        photoId: photo.id,
        variant: "full",
        at: deps.now(),
        purpose: "message",
      });
    }
    const review = reviews.get(photo.id);
    sent.set(photo.id, {
      file,
      review: review ? exportedReview(review) : null,
      description: photo.description,
    });
  }
  // After every read above, so the export appears in the log it returns.
  const accessLog = (
    await repo.listPhotoAccessOfAccount(deps.db, accountId, EXPORT_ACCESS_LOG_LIMIT)
  ).map((entry) => ({
    photoId: entry.photoId,
    variant: entry.variant,
    at: entry.at.toISOString(),
  }));
  const cardsShown = (
    await repo.listCardShownOfAccount(deps.db, accountId, EXPORT_ACCESS_LOG_LIMIT)
  ).map((entry) => ({ photoId: entry.photoId, at: entry.at.toISOString() }));
  return { photos, files, accessLog, cardsShown, sent };
}

/** The moderation outcome as the export says it: who decided, never the labels. */
function exportedReview(review: {
  decision: ExportedPhotoReview["decision"];
  reason: ExportedPhotoReview["reason"];
  decidedBy: string | null;
  decidedAt: Date | null;
}): ExportedPhotoReview {
  return {
    decision: review.decision,
    reason: review.reason,
    decidedByStaff: review.decidedBy !== null,
    decidedAt: review.decidedAt?.toISOString() ?? null,
  };
}
