import { z } from "zod";

/**
 * Photos (#48, TD-2, TD-8). Every upload goes through the API (rule 4): the
 * app pre-resizes and sends the bytes as multipart, the API re-encodes them
 * into three WebP variants under a content-addressed key and discards the
 * original. Nothing here names the object key or the bucket: the app asks for
 * a variant and receives a short-lived signed URL.
 */

export const PhotoId = z.uuid().brand<"PhotoId">().meta({ id: "PhotoId" });
export type PhotoId = z.infer<typeof PhotoId>;

/** thumb in lists, card on open, full on zoom only (rules/mobile.md Images). */
export const PHOTO_VARIANTS = ["thumb", "card", "full"] as const;
export const PhotoVariant = z.enum(PHOTO_VARIANTS).meta({
  id: "PhotoVariant",
  description:
    "thumb: 200×200 for lists. card: 800×1067 when a profile is opened. full: 1600 px long edge, requested only from the zoom screen.",
});
export type PhotoVariant = z.infer<typeof PhotoVariant>;

/** The variants the pipeline makes; the API is the only writer, so the sizes are contract, not configuration. */
export const PHOTO_VARIANT_SIZES = {
  thumb: { width: 200, height: 200 },
  card: { width: 800, height: 1067 },
  full: { longEdge: 1600 },
} as const;

/**
 * pending: uploaded, seen by its owner only, until moderation (#49) decides.
 * approved: may be shown to others. queued: waiting for a human moderator.
 * rejected: a human said no; the owner is told why in words.
 */
export const PhotoState = z.enum(["pending", "approved", "queued", "rejected"]).meta({
  id: "PhotoState",
});
export type PhotoState = z.infer<typeof PhotoState>;

/** The upload's size cap (rules/api.md Media): checked on the Content-Length before any byte is read. */
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
/** Refused from the file header before the decoder runs; the app sends 1600 px, so this is a backstop. */
export const PHOTO_MAX_INPUT_PIXELS = 30_000_000;
/** What the API decodes. An animated GIF is refused, never reduced to a frame. */
const PHOTO_INPUT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const PhotoUploadRequest = z
  .object({
    photo: z
      .file()
      .max(PHOTO_MAX_BYTES)
      .mime([...PHOTO_INPUT_TYPES])
      .meta({
        // The document generator has no mapping for a file schema; this is what it should say.
        type: "string",
        format: "binary",
        description: "The picture, pre-resized to 1600 px by the app; JPEG, PNG or WebP.",
      }),
  })
  .strict()
  .meta({ id: "PhotoUploadRequest" });
export type PhotoUploadRequest = z.infer<typeof PhotoUploadRequest>;

/**
 * Why a moderator said no (#49): a closed list the owner is told in words,
 * never the label names behind it.
 */
export const PhotoRejectionReason = z
  .enum(["nudity", "no_person", "several_people", "minor", "violence", "contact_details", "other"])
  .meta({ id: "PhotoRejectionReason" });
export type PhotoRejectionReason = z.infer<typeof PhotoRejectionReason>;

/** What the owner knows about one of their photos. Never the key, never a URL. */
export const Photo = z
  .object({
    id: PhotoId,
    blurhash: z.string().min(6).max(200).meta({
      description: "Placeholder the app paints before the thumb arrives (computed from the thumb).",
    }),
    width: z.int().positive().meta({ description: "Of the full variant." }),
    height: z.int().positive().meta({ description: "Of the full variant." }),
    state: PhotoState,
    rejectionReason: PhotoRejectionReason.nullable().meta({
      description: "Set when state is rejected: the reason the owner is told.",
    }),
    position: z
      .int()
      .min(0)
      .meta({ description: "0 is the main photo; the owner sets the order." }),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: "Photo" });
export type Photo = z.infer<typeof Photo>;

export const PhotoList = z
  .object({
    photos: z.array(Photo).max(50),
    maxPhotos: z.int().positive().meta({ description: "matching_config max_photos." }),
  })
  .meta({ id: "PhotoList" });
export type PhotoList = z.infer<typeof PhotoList>;

/** Every photo of the account exactly once, in the wanted order. */
export const PhotoOrderRequest = z
  .object({ order: z.array(PhotoId).min(1).max(50) })
  .strict()
  .meta({ id: "PhotoOrderRequest" });
export type PhotoOrderRequest = z.infer<typeof PhotoOrderRequest>;

export const PhotoParams = z.object({ id: PhotoId }).meta({ id: "PhotoParams" });
export const PhotoVariantParams = z
  .object({ id: PhotoId, variant: PhotoVariant })
  .meta({ id: "PhotoVariantParams" });

/** A signed URL, good for fifteen minutes. Never a cache key: the app caches by photoId/variant. */
export const PhotoUrlResponse = z
  .object({
    url: z.url(),
    variant: PhotoVariant,
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: "PhotoUrlResponse" });
export type PhotoUrlResponse = z.infer<typeof PhotoUrlResponse>;

/** The shape of matching_config.photo_fetches_per_day (#52, TD-6): signed URLs per variant per Finnish day. */
export const PhotoFetchBudget = z
  .object({ thumb: z.int().min(0), card: z.int().min(0), full: z.int().min(0) })
  .strict();
export type PhotoFetchBudget = z.infer<typeof PhotoFetchBudget>;
