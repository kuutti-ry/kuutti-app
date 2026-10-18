import { z } from "zod";
import { AccountState } from "./account-state.ts";
import { CONVERSATIONS_MAX, ExportedConversation } from "./chat.ts";
import { DEAL_BREAKERS_CAP, StoredDealBreaker } from "./deal-breakers.ts";
import { ExportedFeedback } from "./feedback.ts";
import { ExportedGate } from "./gate.ts";
import { AuthPlatform, IdentityStanding, USER_AGENT_MAX } from "./identity.ts";
import {
  EXPORT_DESCRIPTION_TEXT_MAX,
  EXPORT_PHOTO_PATH_MAX,
  ExportedPhotoReview,
  Photo,
  PhotoCheckKind,
  PhotoVariant,
} from "./media.ts";
import { ConsentRecord, Gender, PondSummary, PreferencesResponse } from "./onboarding.ts";
import { ProfileDocument } from "./profile.ts";
import { ExportedBlocks, ExportedReports } from "./report.ts";
import { ResearchExport } from "./research.ts";
import { ExportedSanction } from "./sanction.ts";

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

/** A body, so a stray call cannot pause an account; the screen asks the person to say they understand first (#170, ADR-022). */
export const AccountPauseRequest = z
  .object({
    confirm: z
      .literal(true)
      .meta({ description: "Must be true: the person said they understand what a break means." }),
  })
  .strict()
  .meta({ id: "AccountPauseRequest" });
export type AccountPauseRequest = z.infer<typeof AccountPauseRequest>;

export const ExportedPhoto = Photo.extend({
  /** The path of the photo's full-size file inside the zip; null when its object is gone, or the API has no object storage (development without the stand-in). */
  file: z.string().max(EXPORT_PHOTO_PATH_MAX).nullable(),
  review: ExportedPhotoReview.nullable(),
  /** The automatic description in words, in the request's language (#296); null where there is none. The keys it was made from are `description`. */
  descriptionText: z.string().max(EXPORT_DESCRIPTION_TEXT_MAX).nullable(),
}).meta({ id: "ExportedPhoto" });
export type ExportedPhoto = z.infer<typeof ExportedPhoto>;

/**
 * What the photo check holds about the person (#253, ADR-007): the photos it
 * did not show to others in the last twelve months, and whether new ones are
 * checked a little more carefully for now. The texts are in the request's
 * language, so the entry reads as plainly as the app does.
 */
export const ExportedPhotoCheck = z
  .object({
    about: z.string().meta({ description: "What this part is, in the request's language." }),
    photosNotShown: z
      .array(
        z.object({
          at: z.iso.datetime(),
          kind: PhotoCheckKind,
          reason: z.string().meta({ description: "The kind in words, in the request's language." }),
        }),
      )
      .meta({ description: "Oldest first; each goes after twelve months." }),
    carefulCheckUntil: z.iso.datetime().nullable().meta({
      description: "Until when new photos are checked more carefully; null when they are not.",
    }),
  })
  .meta({ id: "ExportedPhotoCheck" });
export type ExportedPhotoCheck = z.infer<typeof ExportedPhotoCheck>;

/**
 * Everything Kuutti holds about the person, as of now. What it does not hold
 * is as telling as what it does: no name, no date of birth beyond year and
 * month, no personal identity code (only its keyed hash, which is omitted
 * because it identifies nothing without the key).
 */
/** The API's version string: `0.16.0-37a837c`, or the tag of a release (CLAUDE.md Git). */
export const EXPORTED_BY_MAX = 100;

export const AccountExport = z
  .object({
    exportedAt: z.iso.datetime(),
    /** Which API wrote the file (#237): the contract this document follows is the one at that version. */
    exportedBy: z.string().max(EXPORTED_BY_MAX),
    account: z.object({
      id: z.uuid(),
      state: AccountState,
      /** When the state last changed; null while it never has. */
      stateChangedAt: z.iso.datetime().nullable(),
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
      /** The standing staff set on the identity (TD-7), and when it last changed. */
      standing: IdentityStanding,
      standingChangedAt: z.iso.datetime().nullable(),
      deletionCount: z.int().min(0),
      /** Bank logins refused while suspended, banned or inside the cooldown (TD-7). */
      refusedAttempts: z.int().min(0),
      /** Until when a new account is refused after a deletion; null when no cooldown is set. */
      reregisterAfter: z.iso.datetime().nullable(),
    }),
    sessions: z.array(
      z.object({
        sessionId: z.uuid(),
        platform: AuthPlatform,
        /** What the device called itself at login; null when it said nothing. */
        userAgent: z.string().max(USER_AGENT_MAX).nullable(),
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
    /** The cards served to the person (ADR-008): each card's photo and the last day it came round, newest first, at most 1000. */
    cardsShown: z.array(z.object({ photoId: z.uuid(), at: z.iso.datetime() })).max(1000),
    /** The photo check's notes and the closer look (#253). */
    photoCheck: ExportedPhotoCheck,
    /** What research holds (#50, ADR-011 §7 and §10): the enrolment, never the events and never the research_id. */
    research: ResearchExport,
    /** The place at the pond gate (#94, ADR-015); null before the first count. */
    gate: ExportedGate.nullable(),
    /** The person's own requests for a copy (#237), this one included, newest first, at most 1000; at most matching_config exports_per_day are answered per Finnish day. */
    exports: z.array(z.object({ at: z.iso.datetime() })).max(1000),
    /** What the person sent as feedback (#171), newest first, at most 1000, with whether a moderator has read it. */
    feedback: z.array(ExportedFeedback).max(1000),
    /** The sanctions on the person (#307, ADR-024 §8), newest first, at most 1000; never who and never staff's note. */
    sanctions: z.array(ExportedSanction).max(1000),
    /** The reports the person filed (#84, ADR-030 §8), with what came of them; never whom, and never a report about the person. */
    reports: ExportedReports,
    /** The blocks the person set (#84, ADR-030 §8), by date; never whom, and never a block set against the person. */
    blocks: ExportedBlocks,
    /** The person's conversations (#348, ADR-031 §5), oldest first: their own messages with the words, the counterpart's as time and length; never whom. */
    conversations: z.array(ExportedConversation).max(CONVERSATIONS_MAX * 2),
  })
  .meta({ id: "AccountExport" });
export type AccountExport = z.infer<typeof AccountExport>;
