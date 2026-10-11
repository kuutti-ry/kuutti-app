import { z } from "zod";
import { AccountState } from "./account-state.ts";

/**
 * Onboarding and consents (#46, ADR-010): the four answers matching cannot
 * start without, the consents nothing may start without, and the research
 * opt-in. Gender is self-declared (rule 3); seeks and the age window are the
 * hard filters of rule 7; a consent names the version of the text it is for.
 */

export const GENDERS = ["woman", "man", "non_binary"] as const;
export const Gender = z.enum(GENDERS).meta({ id: "Gender" });
export type Gender = z.infer<typeof Gender>;

export const AGE_MIN = 18;
export const AGE_MAX = 99;

export const AgeWindow = z
  .object({
    min: z.int().min(AGE_MIN).max(AGE_MAX),
    max: z.int().min(AGE_MIN).max(AGE_MAX),
  })
  .strict()
  .refine((w) => w.min <= w.max, { message: "min is at most max", path: ["max"] })
  .meta({ id: "AgeWindow" });
export type AgeWindow = z.infer<typeof AgeWindow>;

const distinct = (values: readonly string[]) => new Set(values).size === values.length;

/**
 * Whom one seeks, the age window, or both (ADR-010 §13): onboarding saves each
 * on leaving its own screen, so an app closed between the two loses neither.
 */
export const PreferencesUpdate = z
  .object({
    seeks: z
      .array(Gender)
      .min(1)
      .max(GENDERS.length)
      .refine(distinct, { message: "each gender at most once" })
      .optional(),
    ageWindow: AgeWindow.optional(),
  })
  .strict()
  .refine((update) => update.seeks !== undefined || update.ageWindow !== undefined, {
    message: "whom one seeks, the age window or both",
  })
  .meta({ id: "PreferencesUpdate" });
export type PreferencesUpdate = z.infer<typeof PreferencesUpdate>;

export const PreferencesResponse = z
  .object({
    seeks: z.array(Gender).max(GENDERS.length).nullable(),
    ageWindow: AgeWindow.nullable(),
  })
  .meta({ id: "PreferencesResponse" });
export type PreferencesResponse = z.infer<typeof PreferencesResponse>;

export const GenderUpdate = z.object({ gender: Gender }).strict().meta({ id: "GenderUpdate" });
export type GenderUpdate = z.infer<typeof GenderUpdate>;

/** A pond with both case forms: the app never inflects (TD-17). */
export const PondSummary = z
  .object({
    id: z.uuid(),
    slug: z.string().min(1).max(60),
    name: z.string().min(1).max(80),
    nameInessive: z.string().min(1).max(80),
    parentId: z.uuid().nullable(),
  })
  .meta({ id: "PondSummary" });
export type PondSummary = z.infer<typeof PondSummary>;

export const PondList = z.object({ ponds: z.array(PondSummary).max(200) }).meta({ id: "PondList" });
export type PondList = z.infer<typeof PondList>;

export const PondChoice = z.object({ pondId: z.uuid() }).strict().meta({ id: "PondChoice" });
export type PondChoice = z.infer<typeof PondChoice>;

/**
 * The kinds of consent: the two nothing may start without, the research
 * opt-in, and the explicit consent for the special categories of article 9
 * (whom one seeks, politics, religion; one wording, ADR-019 §4). Each names
 * a legal.<kind>.* wording with a consent_version.
 */
export const CONSENT_KINDS = ["terms", "privacy", "research", "special_category"] as const;
export const ConsentKind = z.enum(CONSENT_KINDS).meta({ id: "ConsentKind" });
export type ConsentKind = z.infer<typeof ConsentKind>;

/** The kinds a person withdraws; terms and privacy end with the account (ADR-010 §4). */
export const WITHDRAWABLE_CONSENT_KINDS = ["research", "special_category"] as const;
export const WithdrawableConsentKind = z
  .enum(WITHDRAWABLE_CONSENT_KINDS)
  .meta({ id: "WithdrawableConsentKind" });
export type WithdrawableConsentKind = z.infer<typeof WithdrawableConsentKind>;

/** The languages the texts exist in; the Finnish wording is the binding one (TD-17). */
export const CONSENT_LOCALES = ["fi", "sv", "en"] as const;

export const ConsentRequest = z
  .object({
    kind: ConsentKind,
    /** The consent_version of the wording the person read; an old one is refused. */
    version: z.string().min(1).max(40),
    locale: z.enum(CONSENT_LOCALES),
  })
  .strict()
  .meta({ id: "ConsentRequest" });
export type ConsentRequest = z.infer<typeof ConsentRequest>;

export const ConsentRecord = z
  .object({
    kind: ConsentKind,
    version: z.string().max(40),
    locale: z.enum(CONSENT_LOCALES),
    givenAt: z.iso.datetime(),
    withdrawnAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "ConsentRecord" });
export type ConsentRecord = z.infer<typeof ConsentRecord>;

export const ConsentVersions = z
  .object({
    terms: z.string().max(40),
    privacy: z.string().max(40),
    research: z.string().max(40),
    special_category: z.string().max(40),
  })
  .meta({
    id: "ConsentVersions",
    description: "The consent_version of the current wording per kind.",
  });
export type ConsentVersions = z.infer<typeof ConsentVersions>;

export const ConsentsResponse = z
  .object({
    /** The newest hundred, oldest first; the export carries every row. */
    consents: z.array(ConsentRecord).max(100),
    currentVersions: ConsentVersions,
  })
  .meta({ id: "ConsentsResponse" });
export type ConsentsResponse = z.infer<typeof ConsentsResponse>;

/**
 * The steps of onboarding in the order the app asks them (#146, the field
 * sheet): the two consents on the welcome screen, the name, the gender, whom
 * one seeks (with the special-category consent), the intent, the age window,
 * three photos, two prompts or a bio. The pond is a step only while there is
 * a choice: more than one pond without a parent, or no default (ADR-010 §12);
 * with one, the API assigns it from `matching_config.default_pond`.
 * Research is never one of them.
 */
export const ONBOARDING_STEPS = [
  "terms",
  "privacy",
  "name",
  "gender",
  "seeks",
  "intent",
  "age_window",
  "photos",
  "prompts_or_bio",
  "pond",
] as const;
export const OnboardingStep = z.enum(ONBOARDING_STEPS).meta({ id: "OnboardingStep" });
export type OnboardingStep = z.infer<typeof OnboardingStep>;

/**
 * What the account's state waits for (ADR-010 §6): the four answers matching
 * cannot start without and the two consents. The profile steps are asked in
 * the same flow and keep `complete` false, but an account is active without them.
 */
export const ACTIVATION_STEPS: readonly OnboardingStep[] = [
  "gender",
  "seeks",
  "age_window",
  "pond",
  "terms",
  "privacy",
];

export const OnboardingStatus = z
  .object({
    state: AccountState,
    /** Whole years from the bank-verified year and month (rule 3): the age window's default is built around it. */
    age: z.int().min(AGE_MIN).max(130),
    gender: Gender.nullable(),
    pond: PondSummary.nullable(),
    preferences: PreferencesResponse,
    consents: z.object({
      /** The version accepted, when it is the current one; an old consent reads as null. */
      terms: z.string().max(40).nullable(),
      privacy: z.string().max(40).nullable(),
      /** The special-category consent given with the seek answer (ADR-019 §4), when its version is the current one. */
      specialCategory: z.string().max(40).nullable(),
      /** The active research opt-in, when its version is the current one. */
      research: z.object({ version: z.string().max(40), givenAt: z.iso.datetime() }).nullable(),
    }),
    currentVersions: ConsentVersions,
    /**
     * From when the gender, or whom one seeks, may be changed again (#147,
     * ADR-015 §9): a change is possible once in `change_cadence_days`; null
     * when it is possible now.
     */
    nextChange: z.object({
      gender: z.iso.datetime().nullable(),
      seeks: z.iso.datetime().nullable(),
    }),
    /** In the order the app asks. */
    missing: z.array(OnboardingStep).max(ONBOARDING_STEPS.length),
    /** Nothing missing, the profile steps included; `state` says whether matching may start. */
    complete: z.boolean(),
  })
  .meta({ id: "OnboardingStatus" });
export type OnboardingStatus = z.infer<typeof OnboardingStatus>;
