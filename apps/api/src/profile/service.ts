import { type Queryable, transaction } from "@kuutti/db";
import { CONSENT_VERSIONS } from "@kuutti/i18n";
import {
  PROFILE_FIELD_KEYS,
  PROFILE_FIELDS,
  type ProfileDocument,
  type ProfileResponse,
  type ProfileUpdate,
  SPECIAL_CATEGORY_FIELDS,
} from "@kuutti/schema";
import { AppError } from "../lib/errors.ts";
import { listApprovedPhotos } from "../media/index.ts";
import { track } from "../research/index.ts";
import {
  type CardDeps,
  completenessOf,
  noConsentYet,
  type SpecialCategoryConsent,
} from "./card.ts";
import * as repo from "./repo.ts";
import { contactDetailsIn } from "./text.ts";

/**
 * The consent_version of the special-category wording as built
 * (legal.special_category.* in messages.yaml, ADR-010 §4): a politics or
 * religion answer counts only with the consent of this version (ADR-019 §4).
 */
function specialCategoryVersion(): string {
  const version = CONSENT_VERSIONS.special_category;
  if (!version) {
    throw new Error("messages.yaml has no legal.special_category.* wording with a consent_version");
  }
  return version;
}
export const SPECIAL_CATEGORY_CONSENT_VERSION: string = specialCategoryVersion();

/**
 * Which fields of the update need the explicit consent, given a registry of
 * special-category fields and whether the current wording's consent is on
 * record (#47, ADR-009 §2, ADR-019 §4, #204): a value for one of them without
 * it is refused before anything is written. Pure, so the gate is tested with
 * any registry.
 */
export function consentMissingFor(
  fields: ProfileUpdate["fields"],
  consented: boolean,
  specialFields: readonly string[] = SPECIAL_CATEGORY_FIELDS,
): string[] {
  if (consented) return [];
  return specialFields.filter((key) => (fields as Record<string, unknown>)[key] !== undefined);
}

/** The first field whose text carries a way to reach the person, or null. */
export function contactDetailsInUpdate(
  update: ProfileUpdate,
): { field: string; kind: string } | null {
  const fields = update.fields as Record<string, unknown>;
  const texts: [string, string | null | undefined][] = [
    ["displayName", update.displayName],
    ["bio", update.bio],
    // Every text field of the registry, so a new one is under the rule by construction.
    ...PROFILE_FIELD_KEYS.filter((key) => PROFILE_FIELDS[key].kind === "text").map(
      (key): [string, string | undefined] => [
        `fields.${key}`,
        typeof fields[key] === "string" ? (fields[key] as string) : undefined,
      ],
    ),
    ...update.prompts.map((p, i): [string, string] => [`prompts.${i}.answer`, p.answer]),
  ];
  for (const [field, text] of texts) {
    if (!text) continue;
    const kind = contactDetailsIn(text);
    if (kind) return { field, kind };
  }
  return null;
}

/** The document the owner reads back: the row, and the consent as the consent rows hold it (ADR-019 §4). */
const toDocument = (
  { accountId: _accountId, dropped: _dropped, ...document }: repo.ProfileRow,
  consent: SpecialCategoryConsent,
): ProfileDocument => ({
  ...document,
  specialCategoryConsent: consent
    ? { version: consent.version, at: consent.givenAt.toISOString() }
    : null,
});

const readConsent = (deps: CardDeps, accountId: string): Promise<SpecialCategoryConsent> =>
  (deps.specialCategoryConsent ?? noConsentYet)(deps.db, accountId);

/** A stored value the registry no longer knows: the key goes to the log (never the value) so a backfill can follow. */
function noteDropped(deps: CardDeps, row: repo.ProfileRow | null): void {
  if (row && row.dropped.length > 0) {
    deps.logger.warn({ accountId: row.accountId, dropped: row.dropped }, "profile values dropped");
  }
}

export async function readProfile(deps: CardDeps, accountId: string): Promise<ProfileResponse> {
  const [row, photos, consent] = await Promise.all([
    repo.findProfile(deps.db, accountId),
    listApprovedPhotos(deps.db, accountId),
    readConsent(deps, accountId),
  ]);
  noteDropped(deps, row);
  return {
    profile: row ? toDocument(row, consent) : null,
    completeness: await completenessOf(deps, accountId, row, photos.length),
  };
}

export async function saveProfile(
  deps: CardDeps,
  accountId: string,
  update: ProfileUpdate,
): Promise<ProfileResponse> {
  const contact = contactDetailsInUpdate(update);
  if (contact) {
    throw new AppError(
      400,
      "text_contact_details",
      "Contact details are not for the card",
      contact,
    );
  }
  // The consent is the identity slice's row, given at the seeks step and
  // withdrawn in Settings (ADR-019 §4, #204): a politics or religion answer
  // is refused without the current wording's; an older wording reads as none.
  // The read, the gate and the write share one transaction under the account
  // row's lock, the lock a withdrawal takes: a save either lands before the
  // withdrawal, whose clear then removes the answer, or waits, reads the
  // withdrawn row and is refused. Without the lock a save that read the
  // consent a moment before the withdrawal could leave an answer behind with
  // no consent on record (the security review of 10/10/2026).
  const { row, consent } = await transaction(deps.db, async (tx) => {
    const live = await tx.query(
      "SELECT id FROM account WHERE id = $1 AND state <> 'deleted' FOR UPDATE",
      [accountId],
    );
    // No row, no profile: the account was erased meanwhile (#51).
    if (live.rows.length === 0) throw new AppError(404, "not_found", "No live account");
    const consent = await (deps.specialCategoryConsent ?? noConsentYet)(tx, accountId);
    const missing = consentMissingFor(update.fields, consent !== null);
    if (missing.length > 0) {
      throw new AppError(403, "consent_required", "These fields need the explicit consent first", {
        fields: missing,
        currentVersion: SPECIAL_CATEGORY_CONSENT_VERSION,
      });
    }
    const row = await repo.upsertProfile(tx, accountId, update, deps.now());
    if (!row) throw new AppError(404, "not_found", "No live account");
    return { row, consent };
  });
  const photos = await listApprovedPhotos(deps.db, accountId);
  deps.logger.info({ accountId, prompts: update.prompts.length }, "profile saved");
  const completenessNow = await completenessOf(deps, accountId, row, photos.length);
  // Research (#50): whether profiles get finished; nothing of the text, and nothing without the consent.
  await track(deps, accountId, "profile_saved", {
    complete: completenessNow.complete,
    approvedPhotos: photos.length,
  });
  return { profile: toDocument(row, consent), completeness: completenessNow };
}

/** Erasure (#51): the profile row, inside the caller's transaction. */
export async function eraseProfileOfAccount(tx: Queryable, accountId: string): Promise<number> {
  return repo.deleteProfileOfAccount(tx, accountId);
}

/** The export (#51): the profile as written, or null. */
export async function exportProfile(
  db: Queryable,
  accountId: string,
  consent: SpecialCategoryConsent = null,
): Promise<ProfileDocument | null> {
  const row = await repo.findProfile(db, accountId);
  return row ? toDocument(row, consent) : null;
}

/** The identity slice calls this when the special-category consent is withdrawn (#146). */
export async function withdrawSpecialCategoryAnswers(
  deps: Pick<CardDeps, "db" | "logger" | "now">,
  accountId: string,
): Promise<void> {
  if (await repo.clearSpecialCategoryAnswers(deps.db, accountId, deps.now())) {
    deps.logger.info({ accountId }, "special-category answers cleared");
  }
}
