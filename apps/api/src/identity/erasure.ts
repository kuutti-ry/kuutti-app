import { type Queryable, transaction } from "@kuutti/db";
import type { TFunction } from "@kuutti/i18n";
import type { AccountExport, ExportedPhotoCheck } from "@kuutti/schema";
import { AppError } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import {
  deletePreferencesOfAccount,
  readDealBreakers,
  readPreferences,
} from "../matching/index.ts";
import {
  deleteOrphanedObjects,
  type ExportedPhotoFile,
  erasePhotosOfAccount,
  exportPhotos,
  type MediaDeps,
  type PhotoErasure,
} from "../media/index.ts";
import { deleteGateOfAccount, exportGate, findPondOfAccount } from "../pond/index.ts";
import { eraseProfileOfAccount, exportProfile } from "../profile/index.ts";
import { exportResearch, removeResearchSubject } from "../research/index.ts";
import {
  closerLookOf,
  deletePhotoCheckNotesOfAccount,
  listPhotoCheckNotes,
} from "../safety/index.ts";
import { currentConsent, exportConsents } from "./onboarding.ts";
import { recordDeletion } from "./registration.ts";
import * as repo from "./repo.ts";

// Erasure and export of the caller's own account (#51, TD-7, ADR-007). The
// erasure table of rules/db.md, applied to what exists in M3: sessions, login
// attempts, photos with their review rows and objects, the fetch log, and the
// age on the account row, which stays as an anonymised tombstone. Kept: the
// identity row (with one more deletion and the cooldown), the audit log,
// staff rows. Likes, matches, bookmarks and push tokens join here as their
// slices land; the research_id mapping goes (#50), the events keyed by it stay.
// The place at the pond gate (#94) goes, and is in the export as it is held.
// The photo check's notes (#253) go too, and are in the export in plain words.
// The consent rows go (ADR-010 §14): what they proved goes in the same
// transaction, and the research events carry their own consent_version.
// The export requests go (#237): the person's own trail, listed in the export.

export type ErasureDeps = {
  db: Queryable;
  logger: Logger;
  now: () => Date;
  media?: MediaDeps;
};

/** The export names the API that wrote it (#237); the version string of lib/version.ts. */
export type ExportDeps = ErasureDeps & { version: string };

export type ErasureSummary = {
  sessions: number;
  authRequests: number;
  /** 0 or 1: the profile row (#47). */
  profileRows: number;
  /** The hard preference rows (#46). */
  preferences: number;
  /** The consent rows (ADR-010 §14). */
  consents: number;
  /** The export requests (#237). */
  exports: number;
  /** 0 or 1: the research_id mapping (#50); the events stay, unlinkable. */
  researchSubjects: number;
  photos: number;
  accessRows: number;
  shownRows: number;
  objects: number;
  reregisterAfter: string;
};

/**
 * One transaction for the rows, then the objects. A second call for an
 * account already erased finds no live row and answers 404; in practice the
 * session guard has already refused it, since its sessions are gone.
 */
export async function eraseAccount(deps: ErasureDeps, accountId: string): Promise<ErasureSummary> {
  const at = deps.now();
  const result = await transaction(deps.db, async (tx) => {
    // The account row first, under lock: a profile or preference write that
    // raced this transaction waits here and then sees the tombstone.
    const locked = await repo.lockAccountRow(tx, accountId);
    if (!locked || locked.state === "deleted") {
      throw new AppError(404, "not_found", "No live account to erase");
    }
    const identity = await repo.findIdentitySummaryForAccount(tx, accountId);
    if (!identity) throw new Error("account without identity");
    const sessions = await repo.deleteAccountSessions(tx, accountId);
    const authRequests = await repo.deleteAuthRequestsOfAccount(tx, accountId);
    const photos: PhotoErasure = await erasePhotosOfAccount(tx, accountId);
    // Not in the summary: the line that logs it carries the account id.
    await deletePhotoCheckNotesOfAccount(tx, accountId);
    const profileRows = await eraseProfileOfAccount(tx, accountId);
    // The two hard rows go (TD-7), and the tombstone keeps neither gender nor pond.
    const preferences = await deletePreferencesOfAccount(tx, accountId);
    // The consent rows go (ADR-010 §14): the terms were the condition of use,
    // the sensitive answers they covered went just above, and the events keep
    // the version they were written under; nothing is left to prove.
    const consents = await repo.deleteConsentsOfAccount(tx, accountId);
    const exports = await repo.deleteExportsOfAccount(tx, accountId);
    // The place at the pond gate (#94): where the person stood is theirs, and goes.
    await deleteGateOfAccount(tx, accountId);
    const researchSubjects = await removeResearchSubject(tx, accountId);
    // A second deletion racing the first sees the live row above and the
    // tombstone here (READ COMMITTED re-evaluates after the other commit).
    if (!(await repo.tombstoneAccount(tx, accountId, at))) {
      throw new AppError(404, "not_found", "The account was erased meanwhile");
    }
    const deletion = recordDeletion({ deletionCount: identity.deletionCount }, at);
    await repo.recordIdentityDeletion(tx, identity.identityId, deletion);
    return {
      sessions,
      authRequests,
      photos,
      profileRows,
      preferences,
      consents,
      exports,
      researchSubjects,
      reregisterAfter: deletion.reregisterAfter,
    };
  });
  const objects = deps.media
    ? await deleteOrphanedObjects(
        { db: deps.db, store: deps.media.store, logger: deps.logger },
        result.photos.keys,
        { accountId },
      )
    : 0;
  const summary: ErasureSummary = {
    sessions: result.sessions,
    authRequests: result.authRequests,
    profileRows: result.profileRows,
    preferences: result.preferences,
    consents: result.consents,
    exports: result.exports,
    researchSubjects: result.researchSubjects,
    photos: result.photos.photos,
    accessRows: result.photos.accessRows,
    shownRows: result.photos.shownRows,
    objects,
    reregisterAfter: result.reregisterAfter.toISOString(),
  };
  // The last line that carries this account id.
  deps.logger.info({ accountId, ...summary }, "account erased");
  return summary;
}

/**
 * What the photo check holds (#253), with its texts in the request's language
 * (`t`), so the person reads it as plainly as the app speaks.
 */
async function exportPhotoCheck(
  deps: ErasureDeps,
  accountId: string,
  t: TFunction,
): Promise<ExportedPhotoCheck> {
  const [notes, closer] = await Promise.all([
    listPhotoCheckNotes(deps.db, accountId),
    closerLookOf(deps.db, accountId, deps.now()),
  ]);
  return {
    about: t("account.export.photoCheck.about"),
    photosNotShown: notes.map((note) => ({
      at: note.at.toISOString(),
      kind: note.kind,
      reason: t(`account.export.photoCheck.reason.${note.kind}`),
    })),
    carefulCheckUntil: closer.until?.toISOString() ?? null,
  };
}

/** The export's history, newest first, at most this many rows; the day's cap keeps it short. */
const EXPORT_HISTORY_LIMIT = 1000;

/**
 * Everything Kuutti holds about the person, as of now: the document, and the
 * photo files it points to (#237). `t` is the request's language.
 */
export async function exportAccount(
  deps: ExportDeps,
  accountId: string,
  t: TFunction,
): Promise<{ document: AccountExport; files: ExportedPhotoFile[] }> {
  const account = await repo.findAccountById(deps.db, accountId);
  const identity = await repo.findIdentitySummaryForAccount(deps.db, accountId);
  if (!account || !identity) throw new AppError(404, "not_found", "No such account");
  const sessions = await repo.listSessionsForAccount(deps.db, accountId);
  const media = deps.media
    ? { ...deps.media, db: deps.db, logger: deps.logger, now: deps.now }
    : { db: deps.db, logger: deps.logger, now: deps.now };
  const photos = await exportPhotos(media, accountId);
  const profile = await exportProfile(
    deps.db,
    accountId,
    await currentConsent(deps.db, accountId, "special_category"),
  );
  const [pond, preferences, consents, research, gate, dealBreakers, photoCheck, exports] =
    await Promise.all([
      findPondOfAccount(deps.db, accountId),
      readPreferences(deps.db, accountId),
      exportConsents(deps.db, accountId),
      exportResearch(deps.db, accountId),
      exportGate(deps.db, accountId),
      readDealBreakers(deps.db, accountId, profile?.fields ?? {}),
      exportPhotoCheck(deps, accountId, t),
      repo.listExportsOfAccount(deps.db, accountId, EXPORT_HISTORY_LIMIT),
    ]);
  const document: AccountExport = {
    exportedAt: deps.now().toISOString(),
    exportedBy: deps.version,
    account: {
      id: account.id,
      state: account.state,
      stateChangedAt: account.stateChangedAt?.toISOString() ?? null,
      registeredAt: account.registeredAt.toISOString(),
      birthYear: account.birthYear,
      birthMonth: account.birthMonth,
      gender: account.gender,
      pond,
      genderChangedAt: account.genderChangedAt?.toISOString() ?? null,
      seeksChangedAt: account.seeksChangedAt?.toISOString() ?? null,
      email: account.email,
    },
    preferences,
    dealBreakers,
    consents,
    identity: {
      firstSeenAt: identity.createdAt.toISOString(),
      lastBankLoginAt: identity.authenticatedAt?.toISOString() ?? null,
      loginLevel: identity.acr,
      standing: identity.standing,
      standingChangedAt: identity.standingChangedAt?.toISOString() ?? null,
      deletionCount: identity.deletionCount,
      refusedAttempts: identity.refusedAttempts,
      reregisterAfter: identity.reregisterAfter?.toISOString() ?? null,
    },
    sessions: sessions.map((s) => ({
      sessionId: s.id,
      platform: s.platform === "android" ? "android" : "ios",
      userAgent: s.userAgent,
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: s.lastUsedAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
    })),
    profile,
    photos: photos.photos,
    photoAccessLog: photos.accessLog,
    cardsShown: photos.cardsShown,
    photoCheck,
    research,
    gate,
    exports: exports.map((e) => ({ at: e.at.toISOString() })),
  };
  return { document, files: photos.files };
}
