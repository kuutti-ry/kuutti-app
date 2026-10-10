import type { Queryable } from "@kuutti/db";
import {
  type CardPhoto,
  type Completeness,
  cardFields,
  type ProfileCard,
  type ProfileFields,
  type ProfileUpdate,
} from "@kuutti/schema";
import { AppError } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import {
  dayWindow,
  listApprovedPhotos,
  localYearMonth,
  recordCardServed,
  secondsUntil,
} from "../media/index.ts";
import { findPondOfAccount } from "../pond/index.ts";
import { completeness } from "./completeness.ts";
import * as repo from "./repo.ts";

export const CARDS_PER_DAY_KEY = "exposure_cards_per_day";

/** What onboarding (#46) knows about the subject: the matching slice's readPreferences; without a reader nothing is complete. */
export type PreferenceReader = (
  db: Queryable,
  accountId: string,
) => Promise<{ seeks: unknown | null; ageWindow: unknown | null }>;

export const noPreferencesYet: PreferenceReader = async () => ({ seeks: null, ageWindow: null });

/** The special-category consent as the identity slice's consent rows hold it (ADR-019 §4, #204); without a reader nothing special is stored and the document echoes none. */
export type SpecialCategoryConsent = { version: string; givenAt: Date } | null;
export type ConsentReader = (db: Queryable, accountId: string) => Promise<SpecialCategoryConsent>;

export const noConsentYet: ConsentReader = async () => null;

export type CardDeps = {
  db: Queryable;
  logger: Logger;
  now: () => Date;
  readPreferences?: PreferenceReader;
  specialCategoryConsent?: ConsentReader;
};

/**
 * What both the viewer and the subject answered (#150): the hobbies and
 * languages the card marks "you too". Computed at build time from the two
 * documents, never stored, never a count or a score (the matching
 * document's invariant 6); nothing for the owner's own preview.
 */
export function sharedAnswers(
  viewer: ProfileFields | null,
  subject: ProfileFields,
): ProfileCard["shared"] {
  const both = (key: "hobbies" | "languages"): string[] => {
    const mine: readonly string[] = viewer?.[key] ?? [];
    const theirs: readonly string[] = subject[key] ?? [];
    return theirs.filter((option) => mine.includes(option));
  };
  if (!viewer) return { hobbies: [], languages: [] };
  return { hobbies: both("hobbies"), languages: both("languages") };
}

/** The card's fields: the info and hard ones (ADR-019 §2), less the field of study when the person hides it (#150). */
export function fieldsOnCard(fields: ProfileFields): ProfileFields {
  const out: Record<string, unknown> = { ...cardFields(fields) };
  if (fields.hideFromField === true) delete out.field;
  return out as ProfileFields;
}

/** Whole years from the bank-verified year and month, by the Finnish calendar (rule 3: never a day). */
export function ageInYears(birthYear: number, birthMonth: number, at: Date): number {
  const now = localYearMonth(at);
  const years = now.year - birthYear;
  return now.month >= birthMonth ? years : years - 1;
}

/** The subject's completeness from the rows: the owner's screen, the preview and the round read the same answer. */
export async function completenessOf(
  deps: CardDeps,
  accountId: string,
  profile: Pick<ProfileUpdate, "displayName" | "bio" | "prompts"> | null,
  approvedPhotos: number,
): Promise<Completeness> {
  const preferences = await (deps.readPreferences ?? noPreferencesYet)(deps.db, accountId);
  return completeness({
    displayName: profile?.displayName ?? null,
    bio: profile?.bio ?? null,
    answeredPrompts: profile?.prompts.length ?? 0,
    approvedPhotos,
    seeks: preferences.seeks,
    ageWindow: preferences.ageWindow,
  });
}

/**
 * The card (#47, ADR-009), one builder for two callers. For the owner it is
 * the preview: complete or not, nothing recorded. For anyone else (the round
 * builder of M4; no route in M3) the subject must be live and complete, the
 * shown record is written for every photo on the card and the card counts
 * against matching_config exposure_cards_per_day, both in one statement in
 * the media slice (#52); above the budget a 429 with Retry-After until the
 * Finnish day rolls, said in words and logged. Note for the route M4 adds:
 * completeness (404) is decided before the budget (429), so a viewer over
 * budget could tell a complete subject from the rest by the status; that
 * route answers 429 before the lookup, or 404 in both cases.
 */
export async function buildCard(
  deps: CardDeps,
  input: { viewerAccountId: string; subjectAccountId: string },
): Promise<{ card: ProfileCard | null; completeness: Completeness }> {
  const own = input.viewerAccountId === input.subjectAccountId;
  const subject = await repo.findCardSubject(deps.db, input.subjectAccountId);
  if (!subject || subject.state === "deleted") {
    throw new AppError(404, "not_found", "No such card");
  }
  // For anyone but the owner only a live account is a card: a suspension or
  // a shadow ban holds at this gate too, whatever the caller filtered.
  if (!own && subject.state !== "active") {
    throw new AppError(404, "not_found", "No such card");
  }
  const [photos, pond, viewer] = await Promise.all([
    listApprovedPhotos(deps.db, subject.accountId),
    findPondOfAccount(deps.db, subject.accountId),
    // The viewer's own answers, for what both answered; the owner previews without.
    own ? null : repo.findProfile(deps.db, input.viewerAccountId),
  ]);
  const done = await completenessOf(deps, subject.accountId, subject.profile, photos.length);
  const at = deps.now();
  if (!subject.profile || subject.birthYear === null || subject.birthMonth === null) {
    if (own) return { card: null, completeness: done };
    throw new AppError(404, "not_found", "No such card");
  }
  if (!own) {
    if (!done.complete) throw new AppError(404, "not_found", "No such card");
    const day = dayWindow(at);
    const limit = await matchingConfigNumber(deps.db, CARDS_PER_DAY_KEY);
    const served = await recordCardServed(deps.db, {
      viewerAccountId: input.viewerAccountId,
      subjectAccountId: subject.accountId,
      photoIds: photos.map((p) => p.id),
      at,
      since: day.start,
      limit,
    });
    if (!served.recorded) {
      const retryAfterSeconds = secondsUntil(day.end, at);
      deps.logger.warn(
        {
          accountId: input.viewerAccountId,
          used: served.used,
          limit,
          retryAfterSeconds,
          reason: "card_budget",
        },
        "card refused",
      );
      throw new AppError(429, "card_budget_exceeded", "The day's cards are used up", {
        retryAfterSeconds,
      });
    }
    deps.logger.info(
      {
        accountId: input.viewerAccountId,
        subjectAccountId: subject.accountId,
        photos: photos.length,
      },
      "card served",
    );
  }
  const cardPhotos: CardPhoto[] = photos.map((p) => ({
    id: p.id,
    blurhash: p.blurhash,
    width: p.width,
    height: p.height,
  }));
  return {
    card: {
      accountId: subject.accountId,
      displayName: subject.profile.displayName,
      age: { years: ageInYears(subject.birthYear, subject.birthMonth, at), verifiedByBank: true },
      gender: subject.gender,
      pond,
      photos: cardPhotos,
      // What is there to be seen and what both sides matched on; a soft value or a setting stays on the profile (ADR-019 §2).
      fields: fieldsOnCard(subject.profile.fields),
      bio: subject.profile.bio,
      bioPreset: subject.profile.bioPreset,
      prompts: subject.profile.prompts,
      shared: sharedAnswers(viewer?.fields ?? null, subject.profile.fields),
    },
    completeness: done,
  };
}
