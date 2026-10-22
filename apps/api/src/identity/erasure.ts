import { type Queryable, transaction } from "@kuutti/db";
import { describePhoto, type TFunction } from "@kuutti/i18n";
import type { AccountExport, ExportedPhotoCheck } from "@kuutti/schema";
import { eraseConversationsOf, exportContacts, exportConversations } from "../chat/index.ts";
import { AppError } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import {
  deletePreferencesOfAccount,
  eraseRoundsOf,
  exportRounds,
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
import { eraseNotificationsOf, exportNotifications } from "../notifications/index.ts";
import { deleteGateOfAccount, exportGate, findPondOfAccount } from "../pond/index.ts";
import { eraseProfileOfAccount, exportProfile } from "../profile/index.ts";
import { exportResearch, removeResearchSubject } from "../research/index.ts";
import { eraseInvitationsOf, exportInvitations } from "../rewards/index.ts";
import {
  closerLookOf,
  deleteFeedbackOfAccount,
  deletePhotoCheckNotesOfAccount,
  deleteSanctionsOfAccount,
  listBlocksOfAccount,
  listFeedbackOfAccount,
  listPhotoCheckNotes,
  listReportsOfAccount,
  listSanctionsOfAccount,
  photosHeldByReports,
} from "../safety/index.ts";
import { currentConsent, exportConsents } from "./onboarding.ts";
import { recordDeletion } from "./registration.ts";
import * as repo from "./repo.ts";
import { visibleState } from "./standing.ts";

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
// The feedback goes (#171, ADR-023): the person's own words, listed in the export.
// The sanctions go (#307, ADR-024 §8), except the open bans and suspensions,
// which carry the identity's standing; listed in the export without who or why in staff's words.
// Reports and blocks stay (#84, ADR-030 §8), whoever of the two is erased: a
// report, its note with it, for twelve months from filing (TD-7's report
// snapshots; the night prunes them), a block on the two identities for as
// long as they are kept, so that neither a later account of the blocked
// person nor of the blocker meets the other. The export lists the reports
// the person filed and the blocks they set, from this account or an earlier
// one of their identity, since both are kept on it; never whom. Each report
// says where it was made, a card or a conversation (#351); a conversation's
// frozen copy is in nobody's export, the reporter's included.
// The conversations (#348, ADR-031 §5): the person's link goes and their open
// conversations close; the messages stay for the counterpart, who reads
// "Deleted user" (TD-7's kept side), except those the counterpart never
// received (sent under a shadow ban still open), which go; a conversation
// whose other person was erased before goes whole. The export carries the
// person's own messages and the counterpart's as a time and a length.
// The stored contacts go (#103, ADR-031 §11); the shares, ended by the
// close, stay as the record with no value in them. The export carries the
// stored pieces, and in each conversation the person's own shares.
// The notification choices and the notices go (#176, ADR-032); the export
// carries both.
// The invitations the person made go while open, and the units they earned
// and their notices go with the account (#107, ADR-044 §10); a redeemed one
// stays for its redeemer, the link to the person cut. The invitation the
// person joined with goes until it counts, and once counted stays for its
// inviter without the person; one that would name nobody goes. The export
// carries the invitations made, the one used by its two times, and the
// units; never a code and never the other person.

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
  /** The person's own rounds, their entries with them (#96). */
  rounds: number;
  /** The entries in which the person was somebody's card, decisions on them included (#96). */
  roundEntriesAsCandidate: number;
  /** The consent rows (ADR-010 §14). */
  consents: number;
  /** The export requests (#237). */
  exports: number;
  /** The feedback rows (#171). */
  feedback: number;
  /** The sanction rows that went; the open bans and suspensions stay on the identity (ADR-024 §8). */
  sanctions: number;
  /** 0 or 1: the research_id mapping (#50); the events stay, unlinkable. */
  researchSubjects: number;
  /** The conversations whose link to the person was cut (#348); their messages stay for the counterpart. */
  conversations: number;
  /** The person's messages the counterpart never received, under a shadow ban still open (#348). */
  withheldMessages: number;
  /** Conversations whose other person was erased before: nobody is left to keep them for (#348). */
  emptiedConversations: number;
  /** The stored contacts (#103); their shares stay, ended, as the record. */
  contacts: number;
  /** The notification choices the person switched, and the notices in the app (#176). */
  notificationChoices: number;
  notices: number;
  /** The invitations the person made that went: the open ones, and any whose redeemer was erased before (#107). */
  madeInvitationsDeleted: number;
  /** The invitations the person made that somebody redeemed, kept for their redeemers without the person (#107). */
  madeInvitationsKept: number;
  /** The units of the reward ledger the person's invitations earned (#107). */
  rewardUnits: number;
  /** 0 or 1: the invitation the person joined with, gone because it had not counted or its inviter was erased before (#107). */
  usedInvitationsDeleted: number;
  /** 0 or 1: the same once counted, kept for its inviter without the person (#107). */
  usedInvitationsKept: number;
  photos: number;
  /** Photos a report's copy names, kept for its twelve months (#351); the night's prune deletes them. */
  heldPhotos: number;
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
    // A photo a report's frozen copy holds stays its twelve months (#351, ADR-030 §12).
    const held = await photosHeldByReports(tx, accountId);
    const photos: PhotoErasure = await erasePhotosOfAccount(tx, accountId, held);
    // Not in the summary: the line that logs it carries the account id.
    await deletePhotoCheckNotesOfAccount(tx, accountId);
    const profileRows = await eraseProfileOfAccount(tx, accountId);
    // The two hard rows go (TD-7), and the tombstone keeps neither gender nor pond.
    const preferences = await deletePreferencesOfAccount(tx, accountId);
    // The person's rounds, and the entries in which they are somebody's card,
    // others' likes on them included (TD-7, #96).
    const rounds = await eraseRoundsOf(tx, accountId);
    // The consent rows go (ADR-010 §14): the terms were the condition of use,
    // the sensitive answers they covered went just above, and the events keep
    // the version they were written under; nothing is left to prove.
    const consents = await repo.deleteConsentsOfAccount(tx, accountId);
    const exports = await repo.deleteExportsOfAccount(tx, accountId);
    // The code waiting for the address and the day's sends (#385, ADR-043); the
    // tombstone nulls the address and its confirmation. Not in the summary.
    await repo.deleteEmailRows(tx, accountId);
    const feedback = await deleteFeedbackOfAccount(tx, accountId);
    // Before the sanctions go: what an open shadow ban withheld is known by it (ADR-031 §5).
    const chat = await eraseConversationsOf(
      { db: tx, logger: deps.logger, now: () => at },
      accountId,
    );
    // Before the sanctions: a warning's notice points at its warning (#176).
    const notifications = await eraseNotificationsOf(tx, accountId);
    // After the notices, so the summary counts a counted invitation's notice there.
    const invitations = await eraseInvitationsOf(tx, accountId);
    const sanctions = await deleteSanctionsOfAccount(tx, accountId);
    // Kept: the reports either way and the blocks on the identity (ADR-030 §8).
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
      rounds,
      consents,
      exports,
      feedback,
      sanctions,
      notifications,
      invitations,
      researchSubjects,
      chat,
      heldPhotos: held.length,
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
    rounds: result.rounds.rounds,
    roundEntriesAsCandidate: result.rounds.entriesAsCandidate,
    consents: result.consents,
    exports: result.exports,
    feedback: result.feedback,
    sanctions: result.sanctions,
    researchSubjects: result.researchSubjects,
    conversations: result.chat.conversations,
    withheldMessages: result.chat.withheld,
    emptiedConversations: result.chat.emptied,
    contacts: result.chat.contacts,
    notificationChoices: result.notifications.choices,
    notices: result.notifications.notices,
    madeInvitationsDeleted: result.invitations.madeDeleted,
    madeInvitationsKept: result.invitations.madeKept,
    rewardUnits: result.invitations.units,
    usedInvitationsDeleted: result.invitations.usedDeleted,
    usedInvitationsKept: result.invitations.usedKept,
    photos: result.photos.photos,
    heldPhotos: result.heldPhotos,
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
  const [
    pond,
    preferences,
    consents,
    research,
    gate,
    dealBreakers,
    photoCheck,
    exports,
    feedback,
    sanctions,
    reports,
    blocks,
    conversations,
    contacts,
    notifications,
    rounds,
    invitations,
  ] = await Promise.all([
    findPondOfAccount(deps.db, accountId),
    readPreferences(deps.db, accountId),
    exportConsents(deps.db, accountId),
    exportResearch(deps.db, accountId),
    exportGate(deps.db, accountId),
    readDealBreakers(deps.db, accountId, profile?.fields ?? {}),
    exportPhotoCheck(deps, accountId, t),
    repo.listExportsOfAccount(deps.db, accountId, EXPORT_HISTORY_LIMIT),
    listFeedbackOfAccount(deps.db, accountId, EXPORT_HISTORY_LIMIT),
    listSanctionsOfAccount(deps.db, accountId, EXPORT_HISTORY_LIMIT),
    listReportsOfAccount(deps.db, accountId, EXPORT_HISTORY_LIMIT),
    listBlocksOfAccount(deps.db, accountId, EXPORT_HISTORY_LIMIT),
    // A line's photo with the check's description in words, as a profile photo's (#296, #350).
    exportConversations(deps.db, accountId, (photoId) => {
      const sent = photos.sent.get(photoId);
      if (!sent) return null;
      return {
        ...sent,
        descriptionText: sent.description ? describePhoto(t, sent.description) : null,
      };
    }),
    exportContacts(deps, accountId),
    exportNotifications(deps.db, accountId),
    exportRounds(deps.db, accountId, EXPORT_HISTORY_LIMIT),
    exportInvitations(deps.db, accountId),
  ]);
  const document: AccountExport = {
    exportedAt: deps.now().toISOString(),
    exportedBy: deps.version,
    account: {
      id: account.id,
      // A shadow ban reads as active, as everywhere the person can look (#105, ADR-024 §7).
      state: visibleState(account.state),
      stateChangedAt: account.stateChangedAt?.toISOString() ?? null,
      registeredAt: account.registeredAt.toISOString(),
      birthYear: account.birthYear,
      birthMonth: account.birthMonth,
      gender: account.gender,
      pond,
      genderChangedAt: account.genderChangedAt?.toISOString() ?? null,
      seeksChangedAt: account.seeksChangedAt?.toISOString() ?? null,
      email: account.email,
      foundThemAnswered: account.foundThemAnswered,
      emailConfirmedAt: account.emailConfirmedAt?.toISOString() ?? null,
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
    // The check's description in words too (#296): what the person's photo is
    // heard with, readable in the file without the catalogue.
    photos: photos.photos.map((photo) => ({
      ...photo,
      descriptionText: photo.description ? describePhoto(t, photo.description) : null,
    })),
    photoAccessLog: photos.accessLog,
    cardsShown: photos.cardsShown,
    photoCheck,
    research,
    gate,
    exports: exports.map((e) => ({ at: e.at.toISOString() })),
    feedback,
    // In words in the request's language too, as the photo check's notes are.
    sanctions: sanctions.map((sanction) => ({
      ...sanction,
      kindInWords: t(`account.export.sanction.kind.${sanction.kind}`),
      reasonInWords: t(`account.export.sanction.reason.${sanction.reason}`),
    })),
    // What the person filed and set (ADR-030 §8), in words too; never whom.
    reports: {
      about: t("account.export.report.about"),
      items: reports.map((report) => ({
        at: report.at.toISOString(),
        source: report.source,
        reason: report.reason,
        // The words the person chose in the app, not the sanction's, which state a finding.
        reasonInWords: t(`safety.report.reason.${report.reason}`),
        note: report.note,
        outcome: report.outcome,
        outcomeInWords: t(`account.export.report.outcome.${report.outcome ?? "open"}`),
        decidedAt: report.decidedAt?.toISOString() ?? null,
      })),
    },
    blocks: {
      about: t("account.export.block.about"),
      items: blocks.map((block) => ({ at: block.at.toISOString() })),
    },
    // The person's own words, and the counterpart's as a time and a length (ADR-031 §5); never whom.
    conversations,
    // What the person keeps to share (#103); never what the other person shared.
    contacts,
    // What the person chose to be notified of, and the notices they were shown (#176).
    notifications,
    // The person's own rounds (#96, ADR-034): places, reasons and decisions; never whom.
    rounds: {
      about: t("account.export.round.about"),
      items: rounds.map((round) => ({
        day: round.day,
        builtAt: round.builtAt.toISOString(),
        openedAt: round.openedAt?.toISOString() ?? null,
        completedAt: round.completedAt?.toISOString() ?? null,
        relaxations: round.relaxations.map((relaxation) => ({
          field: relaxation.field,
          fieldInWords: t(`profile.field.${relaxation.field}`),
          kind: relaxation.kind,
          kindInWords: t(`account.export.round.relaxation.${relaxation.kind}`),
          at: relaxation.createdAt.toISOString(),
        })),
        entries: round.entries.map((entry) => ({
          position: entry.position,
          reason: entry.reason,
          reasonInWords: t(`account.export.round.reason.${entry.reason}`),
          relaxedField: entry.relaxedField,
          relaxedFieldInWords: entry.relaxedField ? t(`profile.field.${entry.relaxedField}`) : null,
          seenAt: entry.seenAt?.toISOString() ?? null,
          decision: entry.decision,
          decisionInWords: entry.decision
            ? t(`account.export.round.decision.${entry.decision}`)
            : null,
          decidedAt: entry.decidedAt?.toISOString() ?? null,
        })),
      })),
    },
    // The invitations made and the one used, and the units (#107, ADR-044 §10); never a code or whom.
    invitations,
  };
  return { document, files: photos.files };
}
