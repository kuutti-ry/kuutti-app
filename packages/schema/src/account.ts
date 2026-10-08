import { z } from "zod";
import { AccountState } from "./account-state.ts";
import { DEAL_BREAKERS_CAP, StoredDealBreaker } from "./deal-breakers.ts";
import { ExportedGate } from "./gate.ts";
import { AuthPlatform } from "./identity.ts";
import { Photo, PhotoRejectionReason, PhotoVariant } from "./media.ts";
import { ConsentRecord, Gender, PondSummary, PreferencesResponse } from "./onboarding.ts";
import { ProfileDocument } from "./profile.ts";
import { ResearchExport } from "./research.ts";

/**
 * The account's own lifecycle (#51, TD-7): deletion per the erasure table and
 * the export of what Kuutti holds about the person. Both act on the caller's
 * account only (rule 6); nothing here names another account.
 */

/** A body, so a stray call cannot erase an account; the app shows its own confirmation first. */
/**
 * The optional e-mail (#148, TD-18): a way back in if a phone is lost, never
 * a login, never shown to anybody. Validated as an address and nothing else;
 * no mail is sent until SES exists (M5).
 */
export const EMAIL_MAX = 254;
export const AccountEmail = z
  .object({ email: z.email().max(EMAIL_MAX) })
  .strict()
  .meta({ id: "AccountEmail" });
export type AccountEmail = z.infer<typeof AccountEmail>;

export const AccountEmailResponse = z
  .object({ email: z.string().max(EMAIL_MAX).nullable() })
  .meta({ id: "AccountEmailResponse" });
export type AccountEmailResponse = z.infer<typeof AccountEmailResponse>;

export const AccountDeletionRequest = z
  .object({
    confirm: z
      .literal(true)
      .meta({ description: "Must be true: the person confirmed in the app." }),
  })
  .strict()
  .meta({ id: "AccountDeletionRequest" });
export type AccountDeletionRequest = z.infer<typeof AccountDeletionRequest>;

const SignedVariantUrls = z
  .object({
    thumb: z.url(),
    card: z.url(),
    full: z.url(),
  })
  .meta({ id: "SignedVariantUrls", description: "Fifteen-minute URLs, one per variant." });

export const ExportedPhoto = Photo.extend({
  /** Absent when the API has no object storage configured (development without the stand-in). */
  urls: SignedVariantUrls.nullable(),
  review: z
    .object({
      decision: z.enum(["approved", "queued", "rejected"]),
      reason: PhotoRejectionReason.nullable(),
      decidedByStaff: z
        .boolean()
        .meta({ description: "True when a person decided, false when the automatic check did." }),
      decidedAt: z.iso.datetime().nullable(),
    })
    .nullable()
    .meta({ description: "The moderation outcome; label names are not part of it." }),
}).meta({ id: "ExportedPhoto" });
export type ExportedPhoto = z.infer<typeof ExportedPhoto>;

/**
 * Everything Kuutti holds about the person, as of now. What it does not hold
 * is as telling as what it does: no name, no date of birth beyond year and
 * month, no personal identity code (only its keyed hash, which is omitted
 * because it identifies nothing without the key).
 */
export const AccountExport = z
  .object({
    exportedAt: z.iso.datetime(),
    account: z.object({
      id: z.uuid(),
      state: AccountState,
      registeredAt: z.iso.datetime(),
      birthYear: z.int().nullable(),
      birthMonth: z.int().nullable(),
      /** Self-declared (#46); null before onboarding and after erasure. */
      gender: Gender.nullable(),
      pond: PondSummary.nullable(),
      /** When the gender, or whom one seeks, last changed from an earlier answer (#147); null until then and after erasure. */
      genderChangedAt: z.iso.datetime().nullable(),
      seeksChangedAt: z.iso.datetime().nullable(),
      /** The optional e-mail (#148): the person's own, in their own download; null when none is set. */
      email: z.string().max(EMAIL_MAX).nullable(),
    }),
    /** The two hard rows onboarding writes (#46): whom the person seeks and the age window. */
    preferences: PreferencesResponse,
    /** The person's deal-breakers (#149), each with its pause. */
    dealBreakers: z.array(StoredDealBreaker).max(DEAL_BREAKERS_CAP),
    /** Every consent ever given, withdrawn ones included: the proof of consent (#46, ADR-010). Bounded by the churn cap, not by a page. */
    consents: z.array(ConsentRecord).max(10_000),
    identity: z.object({
      firstSeenAt: z.iso.datetime(),
      lastBankLoginAt: z.iso.datetime().nullable(),
      /** The identification level the bank asserted (acr), a URI. */
      loginLevel: z.string().nullable(),
      deletionCount: z.int().min(0),
    }),
    sessions: z.array(
      z.object({
        sessionId: z.uuid(),
        platform: AuthPlatform,
        createdAt: z.iso.datetime(),
        lastUsedAt: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
      }),
    ),
    /** The profile as written (#47); null when never saved. */
    profile: ProfileDocument.nullable(),
    photos: z.array(ExportedPhoto).max(50),
    /** The person's own fetches of their photos (the exposure log of TD-6), newest first, at most 1000. */
    photoAccessLog: z
      .array(z.object({ photoId: z.uuid(), variant: PhotoVariant, at: z.iso.datetime() }))
      .max(1000),
    /** What research holds (#50, ADR-011): the enrolment and the events, never the research_id. */
    research: ResearchExport,
    /** The place at the pond gate (#94, ADR-015); null before the first count. */
    gate: ExportedGate.nullable(),
  })
  .meta({ id: "AccountExport" });
export type AccountExport = z.infer<typeof AccountExport>;
