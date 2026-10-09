import { type Queryable, transaction } from "@kuutti/db";
import { CONSENT_TEXT_LOCALES, CONSENT_VERSIONS } from "@kuutti/i18n";
import {
  ACTIVATION_STEPS,
  CONSENT_KINDS,
  type ConsentKind,
  type ConsentRecord,
  type ConsentRequest,
  type ConsentsResponse,
  type ConsentVersions,
  type Gender,
  ONBOARDING_STEPS,
  type OnboardingStatus,
  type OnboardingStep,
  PHOTOS_FOR_COMPLETENESS,
  type PondSummary,
  type PreferencesResponse,
  type WithdrawableConsentKind,
} from "@kuutti/schema";
import { AppError } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import { matchingConfigNumber, readMatchingConfig } from "../lib/matching-config.ts";
import {
  CHANGE_CADENCE_KEY,
  deleteSeeksOfAccount,
  nextChangeFrom,
  readPreferences,
} from "../matching/index.ts";
import { listPhotos } from "../media/index.ts";
import {
  admissionAnew,
  findPondBySlug,
  findPondOfAccount,
  setPondOfAccount,
} from "../pond/index.ts";
import { ageInYears, readProfile, withdrawSpecialCategoryAnswers } from "../profile/index.ts";
import { enrolResearchSubject, removeResearchSubject, track } from "../research/index.ts";
import * as repo from "./repo.ts";

// Onboarding and consents (#46, #146, ADR-010). The binding texts live under
// legal.<kind>.* in messages.yaml with a consent_version; the build emits the
// current version per kind, and a consent counts only for that version. The
// status lists the steps of the field sheet in the order the app asks them;
// the account becomes active when the four answers matching cannot start
// without and the two consents are there: a rule computed from the rows on
// every status read, never a flag a route sets.

export type OnboardingDeps = { db: Queryable; logger: Logger; now: () => Date };

/** The matching_config key naming the pond every account is put in while there is one (ADR-010 §10). */
export const DEFAULT_POND_KEY = "default_pond";

function currentVersions(): ConsentVersions {
  const out: Partial<Record<ConsentKind, string>> = {};
  for (const kind of CONSENT_KINDS) {
    const version = CONSENT_VERSIONS[kind];
    if (!version)
      throw new Error(`messages.yaml has no legal.${kind}.* wording with a consent_version`);
    out[kind] = version;
  }
  return out as ConsentVersions;
}

/** The consent_version of each wording as built; a consent must name it to count. */
export const CURRENT_CONSENT_VERSIONS: ConsentVersions = currentVersions();

export type OnboardingAnswers = {
  gender: Gender | null;
  preferences: PreferencesResponse;
  pond: PondSummary | null;
  terms: string | null;
  privacy: string | null;
  /** The special-category consent's version when it is the current one: the seek answer counts only with it (ADR-019 §4). */
  specialCategory: string | null;
  /** What the profile already has of the steps the sheet asks here (#146). */
  profile: { name: boolean; intent: boolean; photos: boolean; promptsOrBio: boolean };
};

/** Pure: the steps still open, in the order the app asks them. Research is never one of them. */
export function missingSteps(input: OnboardingAnswers): OnboardingStep[] {
  const done: Record<OnboardingStep, boolean> = {
    terms: input.terms !== null,
    privacy: input.privacy !== null,
    name: input.profile.name,
    gender: input.gender !== null,
    seeks: input.preferences.seeks !== null && input.specialCategory !== null,
    intent: input.profile.intent,
    age_window: input.preferences.ageWindow !== null,
    photos: input.profile.photos,
    prompts_or_bio: input.profile.promptsOrBio,
    pond: input.pond !== null,
  };
  return ONBOARDING_STEPS.filter((step) => !done[step]);
}

/** Pure: what the account's state waits for, the activation steps among the missing (ADR-010 §6). */
export function activationWaitsFor(missing: readonly OnboardingStep[]): OnboardingStep[] {
  return missing.filter((step) => ACTIVATION_STEPS.includes(step));
}

const toRecord = (row: repo.ConsentRow): ConsentRecord => ({
  kind: row.kind as ConsentKind,
  version: row.version,
  locale: row.locale as ConsentRecord["locale"],
  givenAt: row.givenAt.toISOString(),
  withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
});

/** The active consent of the kind for the current wording, or null: an old version reads as none. */
function acceptedCurrent(rows: repo.ConsentRow[], kind: ConsentKind): repo.ConsentRow | null {
  return (
    rows.find(
      (r) =>
        r.kind === kind && r.withdrawnAt === null && r.version === CURRENT_CONSENT_VERSIONS[kind],
    ) ?? null
  );
}

/**
 * One pond for now (#146, ADR-010 §10 and §11): an account with none is
 * put in the pond matching_config names, on its first status read, so no
 * pond step exists. Where the key names no live pond (several ponds later,
 * or a test database without the seed) the step stays and PUT /account/pond
 * is the way, as before.
 */
async function assignDefaultPond(
  deps: OnboardingDeps,
  accountId: string,
): Promise<PondSummary | null> {
  const slug = await readMatchingConfig(deps.db, DEFAULT_POND_KEY);
  if (typeof slug !== "string" || slug.length === 0) return null;
  const pond = await findPondBySlug(deps.db, slug);
  if (!pond) return null;
  if ((await setPondOfAccount(deps.db, accountId, pond.id)) !== "set") return null;
  deps.logger.info({ accountId, pondId: pond.id }, "pond assigned");
  return pond;
}

export async function onboardingStatus(
  deps: OnboardingDeps,
  accountId: string,
): Promise<OnboardingStatus> {
  const account = await repo.findAccountById(deps.db, accountId);
  if (
    !account ||
    account.state === "deleted" ||
    account.birthYear === null ||
    account.birthMonth === null
  ) {
    throw new AppError(404, "not_found", "No live account");
  }
  const [preferences, consents, profile, photos, cadence] = await Promise.all([
    readPreferences(deps.db, accountId),
    // The newest active row per kind, however long the history (#65 review).
    repo.activeConsents(deps.db, accountId),
    readProfile({ ...deps, readPreferences }, accountId),
    listPhotos(deps.db, accountId),
    matchingConfigNumber(deps.db, CHANGE_CADENCE_KEY),
  ]);
  const now = deps.now();
  const pond =
    (await findPondOfAccount(deps.db, accountId)) ?? (await assignDefaultPond(deps, accountId));
  const terms = acceptedCurrent(consents, "terms")?.version ?? null;
  const privacy = acceptedCurrent(consents, "privacy")?.version ?? null;
  const specialCategory = acceptedCurrent(consents, "special_category")?.version ?? null;
  const research = acceptedCurrent(consents, "research");
  const missing = missingSteps({
    gender: account.gender,
    preferences,
    pond,
    terms,
    privacy,
    specialCategory,
    profile: {
      name: !profile.completeness.missing.includes("display_name"),
      intent: profile.profile?.fields.intent !== undefined,
      // Uploaded and not refused by a person: a photo still with the moderator counts here, on the card only once approved (ADR-006).
      photos: photos.filter((p) => p.state !== "rejected").length >= PHOTOS_FOR_COMPLETENESS,
      promptsOrBio: !profile.completeness.missing.includes("bio_or_prompts"),
    },
  });
  let state = account.state;
  if (activationWaitsFor(missing).length === 0 && state === "registered") {
    if (await repo.activateAccount(deps.db, accountId, deps.now())) {
      state = "active";
      deps.logger.info({ accountId }, "account activated");
    } else {
      // A parallel read won the update: answer with what is now stored.
      const stored = await repo.findAccountById(deps.db, accountId);
      if (stored && stored.state !== "deleted") state = stored.state;
    }
  }
  return {
    state,
    age: ageInYears(account.birthYear, account.birthMonth, now),
    gender: account.gender,
    pond,
    preferences,
    consents: {
      terms,
      privacy,
      specialCategory,
      research: research
        ? { version: research.version, givenAt: research.givenAt.toISOString() }
        : null,
    },
    currentVersions: CURRENT_CONSENT_VERSIONS,
    nextChange: {
      gender: nextChangeFrom(account.genderChangedAt, cadence, now)?.toISOString() ?? null,
      seeks: nextChangeFrom(account.seeksChangedAt, cadence, now)?.toISOString() ?? null,
    },
    missing,
    complete: missing.length === 0,
  };
}

export async function consentsOf(
  deps: OnboardingDeps,
  accountId: string,
): Promise<ConsentsResponse> {
  const rows = await repo.listConsents(deps.db, accountId, repo.CONSENTS_LISTED);
  return { consents: rows.map(toRecord), currentVersions: CURRENT_CONSENT_VERSIONS };
}

/**
 * The language the wording was actually shown in: a phone set to a language
 * the text does not exist in read the English fallback, and the row must say
 * so, never a language nobody wrote (#46 review).
 */
export function shownLocale(
  kind: ConsentKind,
  requested: ConsentRequest["locale"],
): ConsentRequest["locale"] {
  const available = CONSENT_TEXT_LOCALES[kind] ?? [];
  return available.includes(requested) ? requested : "en";
}

/** A consent for the current wording, recorded once; an old version is refused, said in words. */
export async function giveConsent(
  deps: OnboardingDeps,
  accountId: string,
  request: ConsentRequest,
): Promise<ConsentsResponse> {
  if (request.version !== CURRENT_CONSENT_VERSIONS[request.kind]) {
    throw new AppError(409, "agreement_outdated", "The wording has a newer version", {
      kind: request.kind,
    });
  }
  const locale = shownLocale(request.kind, request.locale);
  const at = deps.now();
  const outcome = await transaction(deps.db, async (tx) => {
    const recorded = await repo.recordConsent(
      tx,
      accountId,
      { kind: request.kind, version: request.version, locale },
      at,
    );
    if (recorded === "recorded" && request.kind === "research") {
      // The research_id mapping lives exactly as long as the consent (#50,
      // ADR-011): same transaction, and the opt-in is the first event.
      await enrolResearchSubject(tx, accountId, request.version, at);
      const account = await repo.findAccountById(tx, accountId);
      if (account) {
        await track({ db: tx, logger: deps.logger, now: () => at }, accountId, "research_opt_in", {
          sinceRegistrationD: Math.max(
            0,
            Math.floor((at.getTime() - account.registeredAt.getTime()) / 86_400_000),
          ),
          accountActive: account.state === "active",
        });
      }
    }
    return recorded;
  });
  if (outcome === "no_account") throw new AppError(404, "not_found", "No live account");
  if (outcome === "too_many") {
    throw new AppError(429, "too_many_changes", "The consent changed too often today", {
      kind: request.kind,
    });
  }
  if (outcome === "recorded") {
    deps.logger.info(
      { accountId, kind: request.kind, version: request.version, locale },
      "consent given",
    );
  }
  return consentsOf(deps, accountId);
}

/**
 * The two consents a person withdraws; terms and privacy end with the
 * account. Research takes its research_id mapping with it (ADR-011); the
 * special-category consent takes the article 9 answers with it (ADR-019 §4):
 * whom one seeks, so onboarding asks again, and the politics and religion of
 * the profile. The rows stay as the record of what was agreed and when.
 */
export async function withdrawConsentOf(
  deps: OnboardingDeps,
  accountId: string,
  kind: WithdrawableConsentKind,
): Promise<ConsentsResponse> {
  const outcome = await transaction(deps.db, async (tx) => {
    const withdrawn = await repo.withdrawConsent(tx, accountId, kind, deps.now());
    if (!withdrawn.live) return withdrawn;
    if (kind === "research") {
      // The mapping row goes with the consent; the events stay, unlinkable (ADR-011).
      await removeResearchSubject(tx, accountId);
    } else if (withdrawn.withdrawn > 0) {
      // Only a consent that was there takes the answers with it: a request
      // without one changes nothing, and is no way round the cadence (#147).
      await deleteSeeksOfAccount(tx, accountId);
      await withdrawSpecialCategoryAnswers(
        { db: tx, logger: deps.logger, now: deps.now },
        accountId,
      );
    }
    return withdrawn;
  });
  if (!outcome.live) throw new AppError(404, "not_found", "No live account");
  if (outcome.withdrawn > 0) deps.logger.info({ accountId, kind }, "consent withdrawn");
  return consentsOf(deps, accountId);
}

export async function declareGender(
  deps: OnboardingDeps,
  accountId: string,
  gender: Gender,
): Promise<void> {
  const at = deps.now();
  const declared = await transaction(deps.db, async (tx) => {
    const before = await repo.lockGender(tx, accountId);
    if (before === undefined) return false;
    // A change from an earlier answer is possible once in the cadence (#147,
    // ADR-015 §9), said without a wall: the date, never a reason.
    const change = before.gender !== null && before.gender !== gender;
    if (change) {
      const cadence = await matchingConfigNumber(tx, CHANGE_CADENCE_KEY);
      const from = nextChangeFrom(before.changedAt, cadence, at);
      if (from) {
        throw new AppError(429, "change_too_soon", "The gender was changed recently", {
          from: from.toISOString(),
        });
      }
    }
    if (!(await repo.setGender(tx, accountId, gender, change ? at : null))) return false;
    // The gender decides for whom one competes at the pond gate (#94, ADR-015
    // §9): joining a contest is decided anew by the next count.
    const { seeks } = await readPreferences(tx, accountId);
    await admissionAnew(tx, accountId, { gender: before.gender, seeks }, { gender, seeks });
    return true;
  });
  if (!declared) throw new AppError(404, "not_found", "No live account");
  // The value stays out of the log: self-declared, and nobody's business there.
  deps.logger.info({ accountId }, "gender declared");
}

/** The export (#51): every consent ever given, withdrawn ones included, none left out (ADR-010). */
export async function exportConsents(db: Queryable, accountId: string): Promise<ConsentRecord[]> {
  return (await repo.listConsents(db, accountId)).map(toRecord);
}
