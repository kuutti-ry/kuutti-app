import { type Queryable, transaction } from "@kuutti/db";
import {
  type ConversationThumb,
  PHOTO_VARIANTS,
  type Photo,
  type PhotoCaption,
  type PhotoList,
  type PhotoUrlResponse,
  type PhotoVariant,
} from "@kuutti/schema";
import type { LimitFunction } from "p-limit";
import { AppError } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import { recordPhotoCheckNote } from "../safety/index.ts";
import { dayWindow, readPhotoFetchBudget, secondsUntil } from "./budget.ts";
import {
  CheckUnavailableError,
  checkMessagePhoto,
  type MessagePhotoCheck,
  type Moderator,
  moderatePhoto,
  recordMessagePhotoCheck,
} from "./moderation.ts";
import { PipelineError, processPhoto } from "./pipeline.ts";
import * as repo from "./repo.ts";
import { type MediaStore, objectKey, WEBP } from "./store.ts";
import { photoTips } from "./tips.ts";
import { URL_TTL_MS, type UrlSigner } from "./urls.ts";

/** What the photo routes need beyond the database: injected, so tests hand in a memory store and a test key. */
export type MediaDeps = {
  store: MediaStore;
  signer: UrlSigner;
  /** p-limit at the vCPU count (rules/api.md Media); above it the upload answers 503. */
  limit: LimitFunction;
  /** The automatic check (#49); absent in a bare test app, and the photo stays pending. */
  moderator?: Moderator;
  /**
   * Whether a photo sent in a conversation may be delivered where no check
   * ran (#350): on a developer's machine and in tests, whose stack has no
   * Rekognition. Anywhere else such a photo is refused, so a missing or
   * misnamed moderation parameter never lets one through unchecked.
   */
  deliverUnchecked?: boolean;
};

export type PhotoServiceDeps = MediaDeps & { db: Queryable; logger: Logger; now: () => Date };

export const RETRY_AFTER_SECONDS = 5;
const MAX_PHOTOS_KEY = "max_photos";

const toPhoto = ({ key: _key, ...photo }: repo.PhotoRow): Photo => photo;

export { toPhoto };

export async function listPhotos(deps: PhotoServiceDeps, accountId: string): Promise<PhotoList> {
  const [rows, maxPhotos, advice] = await Promise.all([
    repo.listPhotos(deps.db, accountId),
    matchingConfigNumber(deps.db, MAX_PHOTOS_KEY),
    photoTips(deps.db, accountId),
  ]);
  return { photos: rows.map(toPhoto), maxPhotos, ...advice };
}

/**
 * One upload: count against max_photos, run the pipeline under the
 * concurrency limit, store the three variants, insert the row. The input
 * bytes are referenced by nothing after processPhoto returns; the store only
 * ever receives variants (rule 4).
 */
export async function uploadPhoto(
  deps: PhotoServiceDeps,
  input: { accountId: string; bytes: Uint8Array },
): Promise<Photo> {
  const maxPhotos = await matchingConfigNumber(deps.db, MAX_PHOTOS_KEY);
  // The cheap refusal before any pixel is touched; the insert below applies
  // the same cap again in its own statement, which is the one that holds.
  if ((await repo.countPhotos(deps.db, input.accountId)) >= maxPhotos) {
    throw new AppError(409, "photo_limit", "The account has its maximum number of photos", {
      maxPhotos,
    });
  }
  const processed = await processUnderLimit(deps, input.bytes);
  // The objects first, then the row that owns them. Whatever fails in
  // between, the objects do not stay behind without a row: a picture nobody
  // can reach is still a picture kept (TD-7), so the failure path removes
  // them unless another row already shares the content.
  const dropOrphans = () => dropOrphansOf(deps, processed.key, input.accountId);
  let row: repo.PhotoRow | null;
  try {
    await Promise.all(
      PHOTO_VARIANTS.map((variant) =>
        deps.store.put(objectKey(processed.key, variant), processed.variants[variant], WEBP),
      ),
    );
    row = await repo.insertPhoto(deps.db, {
      accountId: input.accountId,
      key: processed.key,
      blurhash: processed.blurhash,
      width: processed.width,
      height: processed.height,
      maxPhotos,
    });
  } catch (error) {
    await dropOrphans();
    throw error;
  }
  if (!row) {
    await dropOrphans();
    // The insert refuses for two reasons: the account was erased while this
    // upload was processed (#51), or two uploads raced past the count above
    // and this one lost. Only the second is the cap (#235).
    if (!(await repo.isAccountLive(deps.db, input.accountId))) {
      throw new AppError(404, "not_found", "No live account");
    }
    throw new AppError(409, "photo_limit", "The account has its maximum number of photos", {
      maxPhotos,
    });
  }
  deps.logger.info(
    { accountId: input.accountId, photoId: row.id, width: row.width, height: row.height },
    "photo stored",
  );
  // Moderation before anyone else sees it (#49): the card variant is what
  // Rekognition looks at, and the row moves from pending here or stays
  // pending for the nightly retry when the check fails.
  if (deps.moderator) {
    const decided = await moderatePhoto(
      { db: deps.db, logger: deps.logger, moderator: deps.moderator, now: deps.now },
      { photoId: row.id, accountId: input.accountId, card: processed.variants.card },
    );
    if (decided) {
      return toPhoto({
        ...row,
        state: decided.decision,
        rejectionReason: decided.reason ?? null,
        appealable: decided.appealable === true,
        description: decided.description,
      });
    }
  }
  return toPhoto(row);
}

/**
 * The pipeline under the concurrency limit (rules/api.md Media), its
 * failures as the routes say them. Fail closed above the limit rather than
 * queue: a queue is unbounded work on one box (security checklist,
 * "Mishandling of exceptional conditions"). p-limit counts a call as pending
 * until it starts, so both counts matter.
 */
async function processUnderLimit(deps: PhotoServiceDeps, bytes: Uint8Array) {
  if (deps.limit.activeCount + deps.limit.pendingCount >= deps.limit.concurrency) {
    throw new AppError(503, "media_busy", "Image processing is at capacity", {
      active: deps.limit.activeCount,
    });
  }
  try {
    return await deps.limit(() => processPhoto(bytes));
  } catch (error) {
    if (error instanceof PipelineError) {
      const status = error.reason === "unsupported" ? 415 : 422;
      const code = error.reason === "unsupported" ? "photo_unsupported" : "photo_invalid";
      throw new AppError(
        status,
        error.reason === "too_many_pixels" ? "photo_too_many_pixels" : code,
        error.message,
      );
    }
    throw error;
  }
}

/**
 * The objects of a content key nothing refers to any more go: a picture
 * nobody can reach is still a picture kept (TD-7). Another row sharing the
 * content keeps them.
 */
// shortcut: erasure's `deleteOrphanedObjects` window is here too: a send of
// the same picture that stored its objects and has not committed its row
// yet loses them to a refused one's cleanup. A per-content-key ownership
// protocol lifts it, noted for the M4 orphan sweep.
async function dropOrphansOf(deps: PhotoServiceDeps, key: string, accountId: string) {
  try {
    if ((await repo.countRowsForKey(deps.db, key)) === 0) {
      await deps.store.delete(PHOTO_VARIANTS.map((variant) => objectKey(key, variant)));
    }
  } catch (error) {
    deps.logger.error({ accountId, err: error }, "photo orphan cleanup failed");
  }
}

/** A message photo through the pipeline and the check, its objects stored, its row not yet written. */
export type PreparedMessagePhoto = {
  key: string;
  blurhash: string;
  width: number;
  height: number;
  check: MessagePhotoCheck;
  /** Removes the objects unless a row refers to them: for every path that writes no row. */
  dropOrphans: () => Promise<void>;
};

/** The words a refused message photo is told in: one code per reason, since the envelope carries a code. */
const MESSAGE_PHOTO_REFUSAL: Record<string, string> = {
  nudity: "photo_rejected_nudity",
  violence: "photo_rejected_violence",
};

/**
 * A photo sent in a conversation (#350), as far as it goes without the
 * conversation: the pipeline (rule 4: validated, EXIF stripped, re-encoded,
 * the variants, the original referenced by nothing after), then the check on
 * the full size before anything is stored, then the objects. What the check
 * is sure of is refused here and nothing is stored but the check's note
 * (#253); a check that cannot run refuses as busy, so no photo is delivered
 * unchecked. The caller writes
 * the row and the message in one transaction (storeMessagePhoto), and calls
 * dropOrphans on every path that writes no row.
 */
export async function prepareMessagePhoto(
  deps: PhotoServiceDeps,
  input: { accountId: string; bytes: Uint8Array },
): Promise<PreparedMessagePhoto> {
  const processed = await processUnderLimit(deps, input.bytes);
  let check: MessagePhotoCheck;
  try {
    check = await checkMessagePhoto(
      {
        db: deps.db,
        logger: deps.logger,
        moderator: deps.moderator,
        deliverUnchecked: deps.deliverUnchecked,
        now: deps.now,
      },
      { accountId: input.accountId, image: processed.variants.full },
    );
  } catch (error) {
    // Busy, in the words the app already has: try again in a moment.
    if (error instanceof CheckUnavailableError) {
      throw new AppError(503, "media_busy", "The photo check is not available", {
        retryAfterSeconds: CHECK_RETRY_AFTER_SECONDS,
      });
    }
    throw error;
  }
  if (check.decided.decision === "rejected") {
    const reason = check.decided.reason ?? "other";
    if (check.noted) {
      await recordPhotoCheckNote(deps.db, {
        accountId: input.accountId,
        photoId: null,
        kind: check.noted,
        at: check.checkedAt,
      });
    }
    throw new AppError(
      400,
      MESSAGE_PHOTO_REFUSAL[reason] ?? "photo_rejected_other",
      "The check refused the photo",
      { reason },
    );
  }
  const dropOrphans = () => dropOrphansOf(deps, processed.key, input.accountId);
  try {
    await Promise.all(
      PHOTO_VARIANTS.map((variant) =>
        deps.store.put(objectKey(processed.key, variant), processed.variants[variant], WEBP),
      ),
    );
  } catch (error) {
    await dropOrphans();
    throw error;
  }
  return {
    key: processed.key,
    blurhash: processed.blurhash,
    width: processed.width,
    height: processed.height,
    check,
    dropOrphans,
  };
}

/** A message photo is refused this long when the check cannot run: long enough for a blip to pass. */
const CHECK_RETRY_AFTER_SECONDS = 30;

/**
 * The prepared photo's row and its review row, in the caller's transaction
 * (#350): the check's decision as its state, no position, nobody's queue.
 * The id, or null when the account was erased meanwhile (#51).
 */
export async function storeMessagePhoto(
  tx: Queryable,
  input: { accountId: string; photo: PreparedMessagePhoto; at: Date },
): Promise<string | null> {
  const decision = input.photo.check.decided.decision;
  const id = await repo.insertMessagePhoto(tx, {
    accountId: input.accountId,
    key: input.photo.key,
    blurhash: input.photo.blurhash,
    width: input.photo.width,
    height: input.photo.height,
    state: decision === "approved" ? "approved" : "queued",
    at: input.at,
  });
  if (id) await recordMessagePhotoCheck(tx, id, input.photo.check);
  return id;
}

/** The account's message photos of the day, under the lock the caller holds (#350). */
export const countMessagePhotosSince = repo.countMessagePhotosSince;

/**
 * A message photo's URLs end at the next five-minute mark plus the usual
 * fifteen minutes (ADR-005 §3): asked for again within the five minutes, a
 * photo is handed the same URL on CloudFront (the local stand-in signs
 * afresh each second), and the fetch log has it once, two reads at the
 * same instant aside.
 */
const MESSAGE_URL_WINDOW_MS = 5 * 60 * 1000;

/**
 * Signed URLs of the message photos of one answer, for one of their
 * conversations' two people (#350): each photo's thumb and full size, ending
 * at the window's end plus fifteen minutes. One statement writes the fetch
 * log for the lot, a row per photo and variant the reader was not handed in
 * this window already, with the purpose `message`, which the day's budget
 * never counts. Null for a reader erased meanwhile (#51): no row, no URL.
 * The caller has asked, through the reader's own participant row, that they
 * may read each message; the key never leaves the API.
 */
export async function issueMessagePhotoUrls(
  deps: PhotoServiceDeps,
  input: { viewerAccountId: string; photos: ReadonlyArray<{ id: string; key: string }> },
): Promise<Map<string, { thumb: string; full: string; expiresAt: string }> | null> {
  const urls = new Map<string, { thumb: string; full: string; expiresAt: string }>();
  if (input.photos.length === 0) return urls;
  const at = deps.now();
  const windowStart = new Date(
    Math.floor(at.getTime() / MESSAGE_URL_WINDOW_MS) * MESSAGE_URL_WINDOW_MS,
  );
  const expiresAt = new Date(windowStart.getTime() + MESSAGE_URL_WINDOW_MS + URL_TTL_MS);
  for (const photo of input.photos) {
    const [thumb, full] = await Promise.all([
      deps.signer.sign(objectKey(photo.key, "thumb"), expiresAt),
      deps.signer.sign(objectKey(photo.key, "full"), expiresAt),
    ]);
    urls.set(photo.id, { thumb, full, expiresAt: expiresAt.toISOString() });
  }
  const logged = await repo.logMessagePhotoAccess(deps.db, {
    accountId: input.viewerAccountId,
    photoIds: [...urls.keys()],
    at,
    since: windowStart,
  });
  if (!logged.live) return null;
  deps.logger.info(
    { accountId: input.viewerAccountId, photos: urls.size, logged: logged.written, at },
    "message photo urls issued",
  );
  return urls;
}

/** Removes the row; the objects too, when no other row shares the content. */
export async function deletePhoto(
  deps: PhotoServiceDeps,
  accountId: string,
  photoId: string,
): Promise<void> {
  const row = await repo.deletePhoto(deps.db, accountId, photoId);
  if (!row) throw new AppError(404, "not_found", "No such photo of this account");
  await repo.compactPositions(deps.db, accountId);
  if ((await repo.countRowsForKey(deps.db, row.key)) === 0) {
    await deps.store.delete(PHOTO_VARIANTS.map((variant) => objectKey(row.key, variant)));
  }
  deps.logger.info({ accountId, photoId }, "photo deleted");
}

/**
 * The owner asks a person to look at the check's own rejection (#253): once,
 * and never after a nudity label the check was very sure of or a person's
 * decision. The photo waits in the queue again; nobody else sees it before a
 * person approves it.
 */
export async function appealPhoto(
  deps: PhotoServiceDeps,
  accountId: string,
  photoId: string,
): Promise<Photo> {
  const row = await transaction(deps.db, (tx) =>
    repo.appealPhoto(tx, { accountId, photoId, at: deps.now() }),
  );
  if (row) {
    deps.logger.info({ accountId, photoId }, "photo appealed");
    return toPhoto(row);
  }
  const mine = await repo.listPhotos(deps.db, accountId);
  if (!mine.some((photo) => photo.id === photoId)) {
    throw new AppError(404, "not_found", "No such photo of this account");
  }
  throw new AppError(
    409,
    "photo_not_appealable",
    "Only the check's own rejection is appealed, once",
  );
}

/**
 * The owner's line under a photo (#296): a key from the closed list, never
 * the person's text, so nothing is checked; null clears it.
 */
export async function captionPhoto(
  deps: PhotoServiceDeps,
  accountId: string,
  photoId: string,
  caption: PhotoCaption | null,
): Promise<Photo> {
  const row = await repo.setCaption(deps.db, { accountId, photoId, caption });
  if (!row) throw new AppError(404, "not_found", "No such photo of this account");
  deps.logger.info({ accountId, photoId }, "photo captioned");
  return toPhoto(row);
}

/** The order must name every photo of the account exactly once. */
export async function reorderPhotos(
  deps: PhotoServiceDeps,
  accountId: string,
  order: readonly string[],
): Promise<PhotoList> {
  const current = await repo.listPhotos(deps.db, accountId);
  const have = new Set(current.map((p) => p.id as string));
  const asked = new Set(order);
  const complete =
    asked.size === order.length && asked.size === have.size && order.every((id) => have.has(id));
  if (!complete) {
    throw new AppError(400, "photo_order_invalid", "The order does not name every photo once", {
      have: have.size,
      asked: order.length,
    });
  }
  await repo.setPositions(deps.db, accountId, [...order]);
  return listPhotos(deps, accountId);
}

/**
 * A signed URL for one variant of a photo the caller may see: their own, or
 * another account's approved photo on a card they were shown, in the thumb
 * and card sizes (#52, the shown-record rule; the card route of #47 writes
 * the record; ADR-056 §3). Visibility is the query's WHERE clause (rule 6). Every issuance is a photo_access row,
 * written by the statement that counts the day's fetches of the variant
 * against matching_config.photo_fetches_per_day (TD-6, ADR-008): over the
 * budget there is no row and no URL, a 429 with Retry-After until the Finnish
 * day rolls, and a log line the budget metric counts. A fetch of a photo the
 * caller was not shown is a 404 like a missing photo, and a log line for M4's
 * safety review. Nobody is limited in silence: the refusal says so.
 */
export async function issuePhotoUrl(
  deps: PhotoServiceDeps,
  input: { accountId: string; photoId: string; variant: PhotoVariant },
): Promise<PhotoUrlResponse> {
  // Every miss is one line: an unshown or unapproved photo of someone else
  // and a guessed id look the same, and both are what enumeration looks
  // like. The API never asks whether the photo exists outside the caller's
  // scope (rule 6).
  const notVisible = () => {
    deps.logger.warn(
      {
        accountId: input.accountId,
        photoId: input.photoId,
        variant: input.variant,
        reason: "not_visible",
      },
      "photo refused",
    );
    return new AppError(404, "not_found", "No such photo for this account");
  };
  const row = await repo.findVisiblePhoto(deps.db, input.accountId, input.photoId, input.variant);
  if (!row) throw notVisible();
  const at = deps.now();
  const expiresAt = new Date(at.getTime() + URL_TTL_MS);
  // Signed first: signing has no side effect, so a failure there costs the
  // person nothing, while a row written before a failed signature would have
  // spent budget on a URL nobody received. The URL leaves only with the row.
  const url = await deps.signer.sign(objectKey(row.key, input.variant), expiresAt);
  const day = dayWindow(at);
  const limit = (await readPhotoFetchBudget(deps.db))[input.variant];
  const access = await repo.insertPhotoAccess(deps.db, {
    accountId: input.accountId,
    photoId: input.photoId,
    variant: input.variant,
    at,
    since: day.start,
    limit,
  });
  // No live account, no URL: the account was erased between the guard and here (#51).
  if (!access.live) throw new AppError(404, "not_found", "No such photo for this account");
  // A block that landed after findVisiblePhoto looked (#84, ADR-030 §2): the
  // same 404 and line as a photo never shown, and the signed URL goes nowhere.
  if (access.blocked) throw notVisible();
  if (!access.recorded) {
    const retryAfterSeconds = secondsUntil(day.end, at);
    deps.logger.warn(
      {
        accountId: input.accountId,
        variant: input.variant,
        used: access.used,
        limit,
        retryAfterSeconds,
        reason: "budget",
      },
      "photo refused",
    );
    throw new AppError(429, "photo_budget_exceeded", "The day's photo fetches are used up", {
      retryAfterSeconds,
      variant: input.variant,
    });
  }
  deps.logger.info(
    { accountId: input.accountId, photoId: input.photoId, variant: input.variant, at },
    "photo url issued",
  );
  return { url, variant: input.variant, expiresAt: expiresAt.toISOString() };
}

/**
 * The thumb of a conversation's counterpart, for the list (#348, ADR-031 §4):
 * their main photo's thumb variant, signed for fifteen minutes and written to
 * the fetch log under the day's thumb budget, as any fetch is (ADR-008). It
 * never touches the card budget: the conversation is the proof of contact,
 * as a card shown is for a report (ADR-030 §5). Null when there is nothing
 * to show: no approved photo, the owner not active, a block between the two,
 * no conversation of the viewer's with the owner on its other side, the
 * viewer erased meanwhile, or the day's thumbs spent, which leaves its line
 * as a refused fetch does.
 */
export async function issueConversationThumb(
  deps: PhotoServiceDeps,
  input: { viewerAccountId: string; ownerAccountId: string; conversationId: string },
): Promise<ConversationThumb | null> {
  const row = await repo.findMainPhotoOf(deps.db, input);
  if (!row) return null;
  const at = deps.now();
  const expiresAt = new Date(at.getTime() + URL_TTL_MS);
  const url = await deps.signer.sign(objectKey(row.key, "thumb"), expiresAt);
  const day = dayWindow(at);
  const limit = (await readPhotoFetchBudget(deps.db)).thumb;
  const access = await repo.insertPhotoAccess(deps.db, {
    accountId: input.viewerAccountId,
    photoId: row.id,
    variant: "thumb",
    at,
    since: day.start,
    limit,
  });
  if (!access.live || access.blocked) return null;
  if (!access.recorded) {
    deps.logger.warn(
      {
        accountId: input.viewerAccountId,
        variant: "thumb",
        used: access.used,
        limit,
        reason: "budget",
      },
      "photo refused",
    );
    return null;
  }
  deps.logger.info(
    { accountId: input.viewerAccountId, photoId: row.id, variant: "thumb", at },
    "photo url issued",
  );
  return { photoId: row.id, url, blurhash: row.blurhash, expiresAt: expiresAt.toISOString() };
}
