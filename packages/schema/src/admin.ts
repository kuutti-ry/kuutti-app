import { z } from "zod";
import { PhotoId, PhotoRejectionReason, PhotoState } from "./media.ts";

/**
 * The moderation panel's contracts (#49, TD-5, TD-8, rules/admin.md). Staff
 * sign in through the same bank login as everyone; what makes a moderator is
 * a moderator_roles row on their identity. Sessions are eight hours with no
 * refresh. Nothing here carries hetu_hmac or research_id.
 */

export const ModeratorRole = z.enum(["moderator", "admin", "researcher"]).meta({
  id: "ModeratorRole",
});
export type ModeratorRole = z.infer<typeof ModeratorRole>;

/** The one-time code the admin return URL carries, same shape as the app's. */
const OneTimeCode = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const AdminAuthStartQuery = z
  .object({
    locale: z.enum(["fi", "sv", "en"]).optional().meta({
      description: "The language of the bank chooser; defaults to the request's.",
    }),
  })
  .meta({ id: "AdminAuthStartQuery" });
export type AdminAuthStartQuery = z.infer<typeof AdminAuthStartQuery>;

export const AdminAuthExchangeRequest = z
  .object({ code: OneTimeCode })
  .strict()
  .meta({ id: "AdminAuthExchangeRequest" });
export type AdminAuthExchangeRequest = z.infer<typeof AdminAuthExchangeRequest>;

/** An admin session: one bearer token, eight hours, no refresh (rules/api.md). */
export const AdminSession = z
  .object({
    accessToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: z.iso.datetime(),
    role: ModeratorRole,
  })
  .meta({ id: "AdminSession" });
export type AdminSession = z.infer<typeof AdminSession>;

/** One queue on the panel's front page (#303): how many wait, and since when the oldest. */
export const OverviewQueue = z
  .object({
    queue: z.enum(["photos", "feedback"]),
    waiting: z.int().min(0),
    /** When the oldest began to wait: its upload, or for a photo its owner's appeal; null when nothing waits. */
    oldestSince: z.iso.datetime().nullable(),
  })
  .meta({ id: "OverviewQueue" });
export type OverviewQueue = z.infer<typeof OverviewQueue>;

/** The front page (#303): every queue, the API's clock to measure ages by, and the response time promised. */
export const AdminOverview = z
  .object({
    now: z.iso.datetime(),
    /** matching_config moderation_response_hours: past it, the oldest is late (#299). */
    responseHours: z.number().min(0),
    queues: z.array(OverviewQueue).max(10),
  })
  .meta({ id: "AdminOverview" });
export type AdminOverview = z.infer<typeof AdminOverview>;

export const AdminWhoAmI = z
  .object({ role: ModeratorRole, expiresAt: z.iso.datetime() })
  .meta({ id: "AdminWhoAmI" });
export type AdminWhoAmI = z.infer<typeof AdminWhoAmI>;

/** One label Rekognition returned, as stored: name, parent, confidence. Bounded. */
export const ModerationLabel = z
  .object({
    name: z.string().min(1).max(100),
    parentName: z.string().max(100),
    confidence: z.number().min(0).max(100),
  })
  .meta({ id: "ModerationLabel" });
export type ModerationLabel = z.infer<typeof ModerationLabel>;

/** A photo waiting for a person's decision, with what the automatic check saw. */
export const PhotoReviewItem = z
  .object({
    photoId: PhotoId,
    /** The owner's account id: pseudonymous to staff, never hetu_hmac or research_id. */
    accountId: z.uuid(),
    state: PhotoState,
    blurhash: z.string().min(6).max(200),
    width: z.int().positive(),
    height: z.int().positive(),
    uploadedAt: z.iso.datetime(),
    checkedAt: z.iso.datetime().nullable(),
    labels: z.array(ModerationLabel).max(50),
    faces: z.int().min(0),
    /** Why the automatic check did not approve: label names above the threshold, or no face. */
    flagged: z.array(z.string().max(100)).max(50),
    /** The owner asked a person to look at the check's rejection (#253). */
    appealed: z.boolean(),
    /** A label of a hard group at or above its review line: the panel blurs the picture until a tap (#253). */
    sensitive: z.boolean(),
  })
  .meta({ id: "PhotoReviewItem" });
export type PhotoReviewItem = z.infer<typeof PhotoReviewItem>;

export const PhotoReviewQueue = z
  .object({
    items: z.array(PhotoReviewItem).max(100),
    /** Queued photos in total, beyond this page. */
    total: z.int().min(0),
  })
  .meta({ id: "PhotoReviewQueue" });
export type PhotoReviewQueue = z.infer<typeof PhotoReviewQueue>;

export const PhotoReviewQueueQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .meta({ id: "PhotoReviewQueueQuery" });

export const PhotoDecisionRequest = z
  .discriminatedUnion("decision", [
    z.object({ decision: z.literal("approve") }).strict(),
    z.object({ decision: z.literal("reject"), reason: PhotoRejectionReason }).strict(),
  ])
  .meta({ id: "PhotoDecisionRequest" });
export type PhotoDecisionRequest = z.infer<typeof PhotoDecisionRequest>;

export const PhotoDecisionResponse = z
  .object({
    photoId: PhotoId,
    state: PhotoState,
    rejectionReason: PhotoRejectionReason.nullable(),
  })
  .meta({ id: "PhotoDecisionResponse" });
export type PhotoDecisionResponse = z.infer<typeof PhotoDecisionResponse>;
