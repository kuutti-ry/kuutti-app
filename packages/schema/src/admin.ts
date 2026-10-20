import { z } from "zod";
import { ModeratorRejectionReason, PhotoId, PhotoRejectionReason, PhotoState } from "./media.ts";
import { BioPreset, PromptAnswer } from "./profile.ts";
import { ProfileFields } from "./profile-fields.ts";

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
    queue: z.enum(["reports", "automatic_bans", "photos", "feedback"]),
    waiting: z.int().min(0),
    /** When the oldest began to wait: its filing or upload, or for a photo its owner's appeal; null when nothing waits. */
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
    /** matching_config auto_shadow_ban_review_hours: the automatic bans' own deadline (#105). */
    reviewHours: z.number().min(0),
    queues: z.array(OverviewQueue).max(10),
  })
  .meta({ id: "AdminOverview" });
export type AdminOverview = z.infer<typeof AdminOverview>;

/**
 * A moment of the audit log's window: from 1970 on, as no row is older and
 * the database knows no year 0; at most thirty characters, as the database
 * refuses a value longer than its field (a fraction of 130 digits, say).
 */
const instant = z.iso
  .datetime()
  .max(30)
  .refine((value) => Date.parse(value) >= 0, "From 1970 on");

/** The audit log's reader (#309): filters, and the keyset cursor of the page before. */
export const AuditQuery = z
  .object({
    actor: z.uuid().optional(),
    action: z
      .string()
      .regex(/^[a-z]+\.[a-z]+$/)
      .max(60)
      .optional(),
    subjectType: z
      .string()
      .regex(/^[a-z]+$/)
      .max(40)
      .optional(),
    subjectId: z.uuid().optional(),
    from: instant.optional(),
    to: instant.optional(),
    /** The `next` of the page before: older rows than it. */
    before: z.string().max(200).optional(),
  })
  .meta({ id: "AuditQuery" });
export type AuditQuery = z.infer<typeof AuditQuery>;

/** How many audit rows a page holds; no route answers more at once (rules/admin.md: never a bulk export). */
export const AUDIT_PAGE_SIZE = 50;

/** A member of staff (#310): the role, who granted it and when, the last sign-in to the panel. */
export const StaffMember = z
  .object({
    identityId: z.uuid(),
    role: ModeratorRole,
    grantedAt: z.iso.datetime(),
    grantedBy: z.string().max(200),
    lastSignInAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "StaffMember" });
export type StaffMember = z.infer<typeof StaffMember>;

export const StaffList = z
  .object({ items: z.array(StaffMember).max(500) })
  .meta({ id: "StaffList" });
export type StaffList = z.infer<typeof StaffList>;

/** A person's page in the panel (#306): by account id only, never a search. */
export const AdminAccountParams = z.object({ id: z.uuid() }).meta({ id: "AdminAccountParams" });

/** One of the person's photos as staff list it; the picture itself comes by GET /admin/photos/{id}/card, one audit row per look. */
export const AdminAccountPhoto = z
  .object({
    id: z.uuid(),
    state: z.enum(["pending", "queued", "approved", "rejected"]),
    rejectionReason: z.string().max(40).nullable(),
    appealable: z.boolean(),
    uploadedAt: z.iso.datetime(),
  })
  .meta({ id: "AdminAccountPhoto" });
export type AdminAccountPhoto = z.infer<typeof AdminAccountPhoto>;

/** One audit row about the person or one of their photos: who did or saw what, and when. */
export const AdminAuditRow = z
  .object({
    at: z.iso.datetime(),
    /** Null for what no person did: a shadow ban an automatic rule applied (#105). */
    actorIdentityId: z.uuid().nullable(),
    action: z.string().max(60),
    subjectType: z.string().max(40),
    subjectId: z.uuid(),
    detail: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .nullable(),
  })
  .meta({ id: "AdminAuditRow" });
export type AdminAuditRow = z.infer<typeof AdminAuditRow>;

/** A row as the audit log's reader shows it (#309): who by role, and whose page a row is about. */
export const AuditEntry = AdminAuditRow.extend({
  /** The actor's role now; null once it was taken away. */
  actorRole: ModeratorRole.nullable(),
  /** The account the row is about, or the owner of the photo it is about: the person's page (#306). Null otherwise, or for a photo that is gone. */
  accountId: z.uuid().nullable(),
}).meta({ id: "AuditEntry" });
export type AuditEntry = z.infer<typeof AuditEntry>;

/** One page of the audit log, newest first, and the cursor of the next older page; null at the end. */
export const AuditPage = z
  .object({
    items: z.array(AuditEntry).max(AUDIT_PAGE_SIZE),
    next: z.string().max(200).nullable(),
  })
  .meta({ id: "AuditPage" });
export type AuditPage = z.infer<typeof AuditPage>;

/**
 * What a moderator may see about one person (#306): the account's raw state
 * (a shadow ban shows to staff), the identity's standing, the profile as the
 * card shows it, the photos, the feedback they sent, and what staff did or
 * saw about them. Never the hash, the broker's ids, the research id or the
 * e-mail. An erased account answers its deletion and standing, nothing else.
 */
export const AdminAccount = z
  .object({
    id: z.uuid(),
    state: z.enum([
      "registered",
      "active",
      "paused",
      "shadow_banned",
      "suspended",
      "banned",
      "deleted",
    ]),
    stateChangedAt: z.iso.datetime().nullable(),
    /** Null for an erased account, as every field but id, state and deletedAt (#306). */
    registeredAt: z.iso.datetime().nullable(),
    deletedAt: z.iso.datetime().nullable(),
    standing: z.enum(["ok", "suspended", "banned"]).nullable(),
    standingChangedAt: z.iso.datetime().nullable(),
    suspensionEndsAt: z.iso.datetime().nullable(),
    age: z.int().min(0).max(130).nullable(),
    gender: z.string().max(40).nullable(),
    pond: z.string().max(80).nullable(),
    profile: z
      .object({
        displayName: z.string(),
        bio: z.string().nullable(),
        /** The canned bio line the person chose instead of their own words, as the card shows it. */
        bioPreset: BioPreset.nullable(),
        prompts: z.array(PromptAnswer).max(10),
        /** The fields as the card shows them (cardFields): what other people see. */
        fields: ProfileFields,
      })
      .nullable(),
    photos: z.array(AdminAccountPhoto).max(50),
    feedback: z
      .array(
        z.object({
          at: z.iso.datetime(),
          kind: z.string(),
          text: z.string(),
          handledAt: z.iso.datetime().nullable(),
        }),
      )
      .max(100),
    audit: z.array(AdminAuditRow).max(50),
  })
  .meta({ id: "AdminAccount" });
export type AdminAccount = z.infer<typeof AdminAccount>;

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
    z.object({ decision: z.literal("reject"), reason: ModeratorRejectionReason }).strict(),
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
