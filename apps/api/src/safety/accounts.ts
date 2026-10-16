import type { Queryable } from "@kuutti/db";
import type { AdminAccount, AdminAuditRow } from "@kuutti/schema";
import { accountForStaff } from "../identity/index.ts";
import { listPhotos } from "../media/index.ts";
import { findPondOfAccount } from "../pond/index.ts";
import { ageInYears, exportProfile, fieldsOnCard } from "../profile/index.ts";
import { listFeedbackOfAccount } from "./feedback.ts";

// A person's page in the panel (#306): what a moderator may see about one
// account, read across slices through their surfaces. Staff read across
// accounts here by design, behind the admin guard and an audit row per look
// (security checklist line 10); the person's own reads stay scoped by rule 6.
// Raw parameterised SQL through Queryable, as the slices' repositories.

const iso = (at: Date | null) => (at ? at.toISOString() : null);

/** What staff did or saw about the person or one of their photos, newest first, at most a hundred. */
async function auditAbout(db: Queryable, accountId: string): Promise<AdminAuditRow[]> {
  const { rows } = await db.query<{
    at: Date;
    actor_identity_id: string;
    action: string;
    subject_type: string;
    subject_id: string;
    detail: AdminAuditRow["detail"];
  }>(
    `SELECT at, actor_identity_id, action, subject_type, subject_id, detail FROM audit_log
     WHERE (subject_type = 'account' AND subject_id = $1)
        OR (subject_type = 'photo' AND subject_id IN (SELECT id FROM photo WHERE account_id = $1))
     ORDER BY at DESC, id DESC LIMIT 100`,
    [accountId],
  );
  return rows.map((r) => ({
    at: r.at.toISOString(),
    actorIdentityId: r.actor_identity_id,
    action: r.action,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    detail: r.detail ?? null,
  }));
}

/**
 * The page (#306); null for an unknown account. An erased account answers
 * its deletion and its identity's standing, nothing else (ADR-007's
 * tombstone holds nothing more to show).
 */
export async function accountPage(
  db: Queryable,
  accountId: string,
  now: Date,
): Promise<AdminAccount | null> {
  const found = await accountForStaff(db, accountId);
  if (!found) return null;
  const { account } = found;
  const page: AdminAccount = {
    id: account.id,
    state: account.state,
    stateChangedAt: iso(account.stateChangedAt),
    registeredAt: account.registeredAt.toISOString(),
    deletedAt: iso(account.deletedAt),
    standing: found.standing,
    standingChangedAt: iso(found.standingChangedAt),
    suspensionEndsAt: iso(found.suspensionEndsAt),
    age: null,
    gender: null,
    pond: null,
    profile: null,
    photos: [],
    feedback: [],
    audit: [],
  };
  if (account.state === "deleted") return page;
  // One after another: the caller's transaction is one connection.
  const profile = await exportProfile(db, accountId);
  const photos = await listPhotos(db, accountId);
  const pond = await findPondOfAccount(db, accountId);
  const feedback = await listFeedbackOfAccount(db, accountId, 100);
  const audit = await auditAbout(db, accountId);
  return {
    ...page,
    age:
      account.birthYear !== null && account.birthMonth !== null
        ? ageInYears(account.birthYear, account.birthMonth, now)
        : null,
    gender: account.gender,
    pond: pond?.name ?? null,
    // As the card shows it (ADR-009), by the card's own presenter: what other
    // people see, no more (a field of study the person hides stays hidden, #150).
    profile: profile
      ? {
          displayName: profile.displayName,
          bio: profile.bio,
          bioPreset: profile.bioPreset,
          prompts: profile.prompts,
          fields: fieldsOnCard(profile.fields),
        }
      : null,
    photos: photos.slice(0, 50).map((p) => ({
      id: p.id,
      state: p.state,
      rejectionReason: p.rejectionReason,
      appealable: p.appealable,
      uploadedAt: p.createdAt,
    })),
    feedback: feedback.map((f) => ({
      at: f.at,
      kind: f.kind,
      text: f.text,
      handledAt: f.handledAt,
    })),
    audit,
  };
}
