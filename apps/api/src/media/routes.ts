import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  ErrorResponse,
  PHOTO_MAX_BYTES,
  Photo,
  PhotoCaptionRequest,
  PhotoList,
  PhotoOrderRequest,
  PhotoParams,
  PhotoUploadRequest,
  PhotoUrlResponse,
  PhotoVariantParams,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Deps } from "../app.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { AppError, localisedEnvelope } from "../lib/errors.ts";
import {
  appealPhoto,
  captionPhoto,
  deletePhoto,
  issuePhotoUrl,
  listPhotos,
  type PhotoServiceDeps,
  RETRY_AFTER_SECONDS,
  reorderPhotos,
  uploadPhoto,
} from "./photos.ts";

const errorContent = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const bearer = { security: [{ session: [] }] };
const unauthenticated = errorContent("unauthenticated, session_expired or session_revoked.");

const listRoute = createRoute({
  method: "get",
  path: "/photos",
  summary: "The caller's photos",
  description: "In the owner's order, with the blurhash to paint before the bytes arrive.",
  ...bearer,
  responses: {
    200: {
      description:
        "The caller's own photos, with the advisory tips that apply to them, highest priority first (the app shows one at a time), and the fish the fish tip names, or null.",
      ...json(PhotoList),
    },
    401: unauthenticated,
  },
});

const uploadRoute = createRoute({
  method: "post",
  path: "/photos",
  summary: "Upload a photo",
  description:
    "Multipart with one part named photo (JPEG, PNG or WebP, at most 10 MB). The API validates, strips metadata, re-encodes into three WebP variants and keeps no original. The photo is pending until moderation; the owner sees it, nobody else.",
  ...bearer,
  request: {
    body: { required: true, content: { "multipart/form-data": { schema: PhotoUploadRequest } } },
  },
  responses: {
    201: { description: "Stored, pending moderation.", ...json(Photo) },
    400: errorContent("Validation failed (no photo part, or not an accepted type)."),
    401: unauthenticated,
    404: errorContent("not_found: the account was erased while the photo was processed."),
    409: errorContent("photo_limit: the account has max_photos photos already."),
    413: errorContent("payload_too_large: over 10 MB."),
    415: errorContent("photo_unsupported: the bytes are not a JPEG, PNG or WebP."),
    422: errorContent("photo_too_many_pixels or photo_invalid: refused before or by the decoder."),
    503: errorContent(
      "media_busy with Retry-After: image processing is at capacity; or media_unavailable.",
    ),
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/photos/{id}",
  summary: "Remove a photo",
  ...bearer,
  request: { params: PhotoParams },
  responses: {
    204: { description: "Gone, along with its objects when nothing else shared them." },
    400: errorContent("Validation failed."),
    401: unauthenticated,
    404: errorContent("Not a photo of this account."),
  },
});

const appealRoute = createRoute({
  method: "post",
  path: "/photos/{id}/appeal",
  summary: "Ask a person to look at the check's rejection",
  description:
    "Once per photo, for a photo the automatic check rejected (`appealable`); never after a nudity label the check was very sure of, or a person's decision. The photo goes back to the queue and stays unseen by others until a person approves it.",
  ...bearer,
  request: { params: PhotoParams },
  responses: {
    200: { description: "The photo, queued again.", ...json(Photo) },
    400: errorContent("Validation failed."),
    401: unauthenticated,
    404: errorContent("Not a photo of this account."),
    409: errorContent("photo_not_appealable: not the check's own rejection, or appealed already."),
  },
});

const captionRoute = createRoute({
  method: "put",
  path: "/photos/{id}/caption",
  summary: "Set the caption of a photo",
  description:
    "A line from a closed list, shown under the photo to others in their own language (#296); null clears it. A key, never the person's text, so nothing is checked.",
  ...bearer,
  request: { params: PhotoParams, body: { required: true, ...json(PhotoCaptionRequest) } },
  responses: {
    200: { description: "The photo with its caption.", ...json(Photo) },
    400: errorContent("Validation failed: not a line of the list."),
    401: unauthenticated,
    404: errorContent("Not a photo of this account."),
  },
});

const orderRoute = createRoute({
  method: "put",
  path: "/photos/order",
  summary: "Set the order of the photos",
  description:
    "Every photo of the account exactly once, first to last. The main photo is the first approved one in this order (ADR-009 §4).",
  ...bearer,
  request: { body: { required: true, ...json(PhotoOrderRequest) } },
  responses: {
    200: {
      description:
        "The photos in the new order, with the advisory tips that apply to them now that the main photo may have changed, highest priority first (the app shows one at a time), and the fish the fish tip names, or null.",
      ...json(PhotoList),
    },
    400: errorContent("Validation failed, or photo_order_invalid."),
    401: unauthenticated,
  },
});

const urlRoute = createRoute({
  method: "get",
  path: "/photos/{id}/{variant}",
  summary: "A signed URL for one variant",
  description:
    "Valid for fifteen minutes. Every issuance is logged against the caller and counted against the day's budget for the variant (matching_config.photo_fetches_per_day; the day rolls at midnight in Finland). The app caches by photo id and variant, never by this URL, and asks for full only from the zoom screen. Another account's photo is served only from a card the caller was shown.",
  ...bearer,
  request: { params: PhotoVariantParams },
  responses: {
    200: { description: "The URL and when it stops working.", ...json(PhotoUrlResponse) },
    400: errorContent("Validation failed."),
    401: unauthenticated,
    404: errorContent(
      "Not a photo this account may see: not its own, and not on a card it was shown.",
    ),
    429: errorContent(
      "photo_budget_exceeded: the day's fetches of this variant are used up; Retry-After is the wait until the day rolls.",
    ),
    503: errorContent("media_unavailable: no object storage is configured here."),
  },
});

/**
 * `fetched` is the safety slice's velocity check after a URL of a photo in
 * the card or full size (#86, ADR-041), handed in by app.ts as the chat's
 * `opened` is; awaited after the fetch-log row has committed, it changes no
 * answer.
 */
export function photoRoutes(
  deps: Deps,
  requireSession: MiddlewareHandler<AppEnv>,
  fetched: (accountId: string) => Promise<void>,
) {
  const app = new OpenAPIHono<AppEnv>();
  const now = deps.now ?? (() => new Date());

  const serviceDeps = (): PhotoServiceDeps => {
    if (!deps.media) {
      throw new AppError(503, "media_unavailable", "Object storage is not configured here");
    }
    return { ...deps.media, db: deps.db, logger: deps.logger, now };
  };

  // The guard first, so the body of an unauthenticated upload is never read
  // (app.test.ts reads the order from the route table); then this route's own
  // size cap, which replaces the app-wide one that app.ts skips for it.
  const paths = new Set(
    [listRoute, uploadRoute, deleteRoute, appealRoute, captionRoute, orderRoute, urlRoute].map(
      (r) => r.getRoutingPath(),
    ),
  );
  for (const path of paths) app.use(path, requireSession);
  app.use(
    uploadRoute.getRoutingPath(),
    bodyLimit({
      maxSize: PHOTO_MAX_BYTES,
      onError: (c) => c.json(localisedEnvelope(c, "payload_too_large"), 413),
    }),
  );

  app.openapi(listRoute, async (c) => {
    return c.json(await listPhotos(serviceDeps(), callerOf(c).accountId), 200);
  });

  app.openapi(uploadRoute, async (c) => {
    const service = serviceDeps();
    const { photo } = c.req.valid("form");
    const bytes = new Uint8Array(await photo.arrayBuffer());
    try {
      const stored = await uploadPhoto(service, { accountId: callerOf(c).accountId, bytes });
      return c.json(stored, 201);
    } catch (error) {
      if (error instanceof AppError && error.code === "media_busy") {
        c.header("Retry-After", String(RETRY_AFTER_SECONDS));
      }
      throw error;
    }
  });

  app.openapi(deleteRoute, async (c) => {
    await deletePhoto(serviceDeps(), callerOf(c).accountId, c.req.valid("param").id);
    return c.body(null, 204);
  });

  app.openapi(appealRoute, async (c) => {
    const photo = await appealPhoto(serviceDeps(), callerOf(c).accountId, c.req.valid("param").id);
    return c.json(photo, 200);
  });

  app.openapi(captionRoute, async (c) => {
    const photo = await captionPhoto(
      serviceDeps(),
      callerOf(c).accountId,
      c.req.valid("param").id,
      c.req.valid("json").caption,
    );
    return c.json(photo, 200);
  });

  app.openapi(orderRoute, async (c) => {
    const { order } = c.req.valid("json");
    return c.json(await reorderPhotos(serviceDeps(), callerOf(c).accountId, order), 200);
  });

  app.openapi(urlRoute, async (c) => {
    const { id, variant } = c.req.valid("param");
    const { accountId } = callerOf(c);
    try {
      const url = await issuePhotoUrl(serviceDeps(), { accountId, photoId: id, variant });
      // A thumb never counts (othersPhotoFetchesSince), so it is not checked.
      if (variant !== "thumb") await fetched(accountId);
      return c.json(url, 200);
    } catch (error) {
      if (error instanceof AppError && error.code === "photo_budget_exceeded") {
        const wait = (error.detail as { retryAfterSeconds?: number } | undefined)
          ?.retryAfterSeconds;
        c.header("Retry-After", String(wait ?? 1));
      }
      throw error;
    }
  });

  return app;
}

/** The one route whose body may exceed the app-wide limit; app.ts skips the global cap for it. */
export const UPLOAD_ROUTE = { method: "POST", path: "/photos" } as const;
