import { z } from "zod";
import { PhotoId } from "./media.ts";
import { PondSummary } from "./onboarding.ts";
import { ProfileFields } from "./profile-fields.ts";

/**
 * The profile as the person writes it and the card as others see it (#47,
 * TD-16, ADR-009). Everything the person types is short and passes the
 * plain-text rule (no contact details) at the API; everything else is a
 * choice from the registry (profile-fields.ts). The card carries the
 * subject's account id and nothing of anyone else, never a like or exposure
 * count (rules/schema.md).
 */

export const DISPLAY_NAME_MAX = 20;
export const BIO_MAX = 500;
/** A bio this long counts for completeness; shorter needs two prompts instead. */
export const BIO_MIN_FOR_COMPLETENESS = 50;
export const PROMPT_ANSWER_MAX = 160;
export const PROMPTS_MAX = 3;
export const PROMPTS_FOR_COMPLETENESS = 2;
/** Approved photos a profile needs before it is complete (#47; two since #56). */
export const PHOTOS_FOR_COMPLETENESS = 2;
/** A profile with enough photos to be complete, but fewer than this, gets the tip to add one (#56). */
export const PHOTOS_SUGGESTED = 3;

/** The prompts a person may answer; texts are i18n keys profile.prompt.<key>. */
export const PROMPT_KEYS = [
  "sunday",
  "proud_of",
  "argue_about",
  "unpopular_opinion",
  "teach_me",
  "first_date",
  "never_again",
  "overrated",
  "hidden_talent",
  "last_laugh",
  "three_things",
  "ask_me",
] as const;
export const PromptKey = z.enum(PROMPT_KEYS).meta({ id: "PromptKey" });
export type PromptKey = z.infer<typeof PromptKey>;

/** For the person who will not write a bio: a canned line, shown translated; texts are profile.bioPreset.<key>. */
export const BIO_PRESETS = ["lazy_nice_fellow", "ask_me_instead", "photos_speak"] as const;
export const BioPreset = z.enum(BIO_PRESETS).meta({ id: "BioPreset" });
export type BioPreset = z.infer<typeof BioPreset>;

export const PromptAnswer = z
  .object({
    key: PromptKey,
    answer: z.string().trim().min(1).max(PROMPT_ANSWER_MAX),
  })
  .strict()
  .meta({ id: "PromptAnswer" });
export type PromptAnswer = z.infer<typeof PromptAnswer>;

const distinctPrompts = (prompts: { key: string }[]) =>
  new Set(prompts.map((p) => p.key)).size === prompts.length;

/** What the person sends: the whole profile every time, so the row is the document. */
export const ProfileUpdate = z
  .object({
    displayName: z.string().trim().min(1).max(DISPLAY_NAME_MAX),
    bio: z.string().trim().min(1).max(BIO_MAX).nullable(),
    bioPreset: BioPreset.nullable(),
    fields: ProfileFields,
    prompts: z.array(PromptAnswer).max(PROMPTS_MAX),
    /** The version of the special-category consent text the person accepted; null withdraws it (ADR-009). */
    specialCategoryConsent: z
      .object({ version: z.string().min(1).max(40) })
      .strict()
      .nullable(),
  })
  .strict()
  .refine((p) => !(p.bio !== null && p.bioPreset !== null), {
    message: "a bio or a placeholder, not both",
    path: ["bioPreset"],
  })
  .refine((p) => distinctPrompts(p.prompts), {
    message: "each prompt at most once",
    path: ["prompts"],
  })
  .meta({ id: "ProfileUpdate" });
export type ProfileUpdate = z.infer<typeof ProfileUpdate>;

/** What is still missing before the profile can enter a round (#47; the tips of #56 read it). */
export const CompletenessItem = z
  .enum(["display_name", "photos", "bio_or_prompts", "seeks", "age_window"])
  .meta({ id: "CompletenessItem" });
export type CompletenessItem = z.infer<typeof CompletenessItem>;

export const Completeness = z
  .object({
    complete: z.boolean(),
    missing: z.array(CompletenessItem).max(8),
  })
  .meta({ id: "Completeness" });
export type Completeness = z.infer<typeof Completeness>;

/**
 * Advisory profile tips for the owner (#56). One tip at a time; never gates
 * completeness, moderation, or matching. Kinds grow as label rules land.
 * A kind names what was noticed; the words for it are the client's.
 */
export const TipKind = z.enum(["few_photos"]).meta({ id: "TipKind" });
export type TipKind = z.infer<typeof TipKind>;

/** The stored profile, as the owner reads it back. */
export const ProfileDocument = z
  .object({
    displayName: z.string().max(DISPLAY_NAME_MAX),
    bio: z.string().max(BIO_MAX).nullable(),
    bioPreset: BioPreset.nullable(),
    fields: ProfileFields,
    prompts: z.array(PromptAnswer).max(PROMPTS_MAX),
    specialCategoryConsent: z
      .object({ version: z.string().max(40), at: z.iso.datetime() })
      .nullable(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: "ProfileDocument" });
export type ProfileDocument = z.infer<typeof ProfileDocument>;

export const ProfileResponse = z
  .object({
    /** Null until the first save. */
    profile: ProfileDocument.nullable(),
    completeness: Completeness,
    /** The highest-priority tip, or null when none applies. */
    tip: TipKind.nullable(),
  })
  .meta({ id: "ProfileResponse" });
export type ProfileResponse = z.infer<typeof ProfileResponse>;

/** A photo on a card: enough to paint and to ask GET /photos/{id}/{variant} for the bytes, never a URL. */
export const CardPhoto = z
  .object({
    id: PhotoId,
    blurhash: z.string().min(6).max(200),
    width: z.int().positive(),
    height: z.int().positive(),
  })
  .meta({ id: "CardPhoto" });
export type CardPhoto = z.infer<typeof CardPhoto>;

/**
 * What another person sees. The age is whole years from the bank-verified
 * year and month, and the card says so; nothing else about the person is
 * verified by anyone.
 */
export const ProfileCard = z
  .object({
    accountId: z.uuid(),
    displayName: z.string().max(DISPLAY_NAME_MAX),
    age: z.object({
      years: z.int().min(18).max(130),
      verifiedByBank: z.literal(true),
    }),
    /** Where the person matches (#46); null until onboarding set it. */
    pond: PondSummary.nullable(),
    photos: z.array(CardPhoto).max(50),
    fields: ProfileFields,
    bio: z.string().max(BIO_MAX).nullable(),
    bioPreset: BioPreset.nullable(),
    prompts: z.array(PromptAnswer).max(PROMPTS_MAX),
  })
  .meta({ id: "ProfileCard" });
export type ProfileCard = z.infer<typeof ProfileCard>;

/** The owner's preview of their own card, complete or not, with what is missing. */
export const CardPreviewResponse = z
  .object({
    card: ProfileCard.nullable(),
    completeness: Completeness,
    /** The highest-priority tip, or null when none applies. */
    tip: TipKind.nullable(),
  })
  .meta({ id: "CardPreviewResponse" });
export type CardPreviewResponse = z.infer<typeof CardPreviewResponse>;
