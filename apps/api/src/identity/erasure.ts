import { type Queryable, transaction } from "@kuutti/db";
import type { AccountExport } from "@kuutti/schema";
import { AppError } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import { deletePreferencesOfAccount, readPreferences } from "../matching/index.ts";
import {
  deleteOrphanedObjects,
  erasePhotosOfAccount,
  exportPhotos,
  type MediaDeps,
  type PhotoErasure,
} from "../media/index.ts";
import { deleteGateOfAccount, exportGate, findPondOfAccount } from "../pond/index.ts";
import { eraseProfileOfAccount, exportProfile } from "../profile/index.ts";
import { exportResearch, removeResearchSubject } from "../research/index.ts";
import { exportConsents } from "./onboarding.ts";
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

export type ErasureDeps = {
  db: Queryable;
  logger: Logger;
  now: () => Date;
  media?: MediaDeps;
};

export type ErasureSummary = {
  sessions: number;
  authRequests: number;
  /** 0 or 1: the profile row (#47). */
  profileRows: number;
  /** The hard preference rows (#46). */
  preferences: number;
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
    const locked = await repo.lockAccountForErasure(tx, accountId);
    if (!locked || locked.state === "deleted") {
      throw new AppError(404, "not_found", "No live account to erase");
    }
    const identity = await repo.findIdentitySummaryForAccount(tx, accountId);
    if (!identity) throw new Error("account without identity");
    const sessions = await repo.deleteAccountSessions(tx, accountId);
    const authRequests = await repo.deleteAuthRequestsOfAccount(tx, accountId);
    const photos: PhotoErasure = await erasePhotosOfAccount(tx, accountId);
    const profileRows = await eraseProfileOfAccount(tx, accountId);
    // The two hard rows go (TD-7); the consent rows stay as proof (ADR-010),
    // and the tombstone keeps neither gender nor pond.
    const preferences = await deletePreferencesOfAccount(tx, accountId);
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

/** Everything Kuutti holds about the person, as of now. */
export async function exportAccount(deps: ErasureDeps, accountId: string): Promise<AccountExport> {
  const account = await repo.findAccountById(deps.db, accountId);
  const identity = await repo.findIdentitySummaryForAccount(deps.db, accountId);
  if (!account || !identity) throw new AppError(404, "not_found", "No such account");
  const sessions = await repo.listSessionsForAccount(deps.db, accountId);
  const media = deps.media
    ? { ...deps.media, db: deps.db, logger: deps.logger, now: deps.now }
    : { db: deps.db, logger: deps.logger, now: deps.now };
  const photos = await exportPhotos(media, accountId);
  const profile = await exportProfile(deps.db, accountId);
  const [pond, preferences, consents, research, gate] = await Promise.all([
    findPondOfAccount(deps.db, accountId),
    readPreferences(deps.db, accountId),
    exportConsents(deps.db, accountId),
    exportResearch(deps.db, accountId),
    exportGate(deps.db, accountId),
  ]);
  return {
    exportedAt: deps.now().toISOString(),
    account: {
      id: account.id,
      state: account.state,
      registeredAt: account.registeredAt.toISOString(),
      birthYear: account.birthYear,
      birthMonth: account.birthMonth,
      gender: account.gender,
      pond,
      genderChangedAt: account.genderChangedAt?.toISOString() ?? null,
      seeksChangedAt: account.seeksChangedAt?.toISOString() ?? null,
    },
    preferences,
    consents,
    identity: {
      firstSeenAt: identity.createdAt.toISOString(),
      lastBankLoginAt: identity.authenticatedAt?.toISOString() ?? null,
      loginLevel: identity.acr,
      deletionCount: identity.deletionCount,
    },
    sessions: sessions.map((s) => ({
      sessionId: s.id,
      platform: s.platform === "android" ? "android" : "ios",
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: s.lastUsedAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
    })),
    profile,
    photos: photos.photos,
    photoAccessLog: photos.accessLog,
    research,
    gate,
  };
}
