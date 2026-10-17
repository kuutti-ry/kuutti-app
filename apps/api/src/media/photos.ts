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
import { dayWindow, readPhotoFetchBudget, secondsUntil } from "./budget.ts";
import { type Moderator, moderatePhoto } from "./moderation.ts";
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
  // Fail closed above the limit rather than queue: a queue is unbounded work
  // on one box (security checklist, "Mishandling of exceptional conditions").
  // p-limit counts a call as pending until it starts, so both counts matter.
  if (deps.limit.activeCount + deps.limit.pendingCount >= deps.limit.concurrency) {
    throw new AppError(503, "media_busy", "Image processing is at capacity", {
      active: deps.limit.activeCount,
    });
  }
  let processed: Awaited<ReturnType<typeof processPhoto>>;
  try {
    processed = await deps.limit(() => processPhoto(input.bytes));
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
  // The objects first, then the row that owns them. Whatever fails in
  // between, the objects do not stay behind without a row: a picture nobody
  // can reach is still a picture kept (TD-7), so the failure path removes
  // them unless another row already shares the content.
  const keys = PHOTO_VARIANTS.map((variant) => objectKey(processed.key, variant));
  const dropOrphans = async () => {
    try {
      if ((await repo.countRowsForKey(deps.db, processed.key)) === 0) {
        await deps.store.delete(keys);
      }
    } catch (error) {
      deps.logger.error({ accountId: input.accountId, err: error }, "photo orphan cleanup failed");
    }
  };
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
 * another account's approved photo on a card they were shown (#52, the
 * shown-record rule; the card route of #47 writes the record). Visibility is
 * the query's WHERE clause (rule 6). Every issuance is a photo_access row,
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
  const row = await repo.findVisiblePhoto(deps.db, input.accountId, input.photoId);
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
