import type { Queryable } from "@kuutti/db";
import {
  type CardPreviewResponse,
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
import { buildCard, type CardDeps, completenessOf } from "./card.ts";
import * as repo from "./repo.ts";
import { contactDetailsIn } from "./text.ts";
import { tips } from "./tips.ts";

/**
 * Which fields of the update need the explicit consent, given a registry of
 * special-category fields (#47, ADR-009): a value for one of them without the
 * consent version is refused before anything is written. Pure, so the gate is
 * tested with a registry that has such a field while the real one has none.
 */
export function consentMissingFor(
  update: Pick<ProfileUpdate, "fields" | "specialCategoryConsent">,
  specialFields: readonly string[] = SPECIAL_CATEGORY_FIELDS,
): string[] {
  if (update.specialCategoryConsent) return [];
  return specialFields.filter(
    (key) => (update.fields as Record<string, unknown>)[key] !== undefined,
  );
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

const toDocument = ({
  accountId: _accountId,
  dropped: _dropped,
  ...document
}: repo.ProfileRow): ProfileDocument => document;

/** A stored value the registry no longer knows: the key goes to the log (never the value) so a backfill can follow. */
function noteDropped(deps: CardDeps, row: repo.ProfileRow | null): void {
  if (row && row.dropped.length > 0) {
    deps.logger.warn({ accountId: row.accountId, dropped: row.dropped }, "profile values dropped");
  }
}

export async function readProfile(deps: CardDeps, accountId: string): Promise<ProfileResponse> {
  const [row, photos] = await Promise.all([
    repo.findProfile(deps.db, accountId),
    listApprovedPhotos(deps.db, accountId),
  ]);
  noteDropped(deps, row);
  return {
    profile: row ? toDocument(row) : null,
    completeness: await completenessOf(deps, accountId, row, photos.length),
    tips: tips({ approvedPhotos: photos.length }),
  };
}

export async function previewCard(deps: CardDeps, accountId: string): Promise<CardPreviewResponse> {
  const { card, completeness } = await buildCard(deps, {
    viewerAccountId: accountId,
    subjectAccountId: accountId,
  });
  const approvedPhotos =
    card?.photos.length ?? (await listApprovedPhotos(deps.db, accountId)).length;
  return { card, completeness, tips: tips({ approvedPhotos }) };
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
  const missing = consentMissingFor(update);
  if (missing.length > 0) {
    throw new AppError(403, "consent_required", "These fields need the explicit consent first", {
      fields: missing,
    });
  }
  // Nothing is flagged today (ADR-009 §2), so a consent version has nothing
  // to bind to and is not stored: a row that looks like consent given for a
  // text nobody can point at would be worse than none. The issue that flags
  // a field (#46 for seeks) binds the version and lifts this.
  if (update.specialCategoryConsent && SPECIAL_CATEGORY_FIELDS.length === 0) {
    throw new AppError(400, "validation_failed", "No field takes a special-category consent yet");
  }
  const row = await repo.upsertProfile(deps.db, accountId, update, deps.now());
  // No row, no profile: the account was erased between the guard and here (#51).
  if (!row) throw new AppError(404, "not_found", "No live account");
  const photos = await listApprovedPhotos(deps.db, accountId);
  deps.logger.info({ accountId, prompts: update.prompts.length }, "profile saved");
  const completenessNow = await completenessOf(deps, accountId, row, photos.length);
  // Research (#50): whether profiles get finished; nothing of the text, and nothing without the consent.
  await track(deps, accountId, "profile_saved", {
    complete: completenessNow.complete,
    approvedPhotos: photos.length,
  });
  return {
    profile: toDocument(row),
    completeness: completenessNow,
    tips: tips({ approvedPhotos: photos.length }),
  };
}

/** Erasure (#51): the profile row, inside the caller's transaction. */
export async function eraseProfileOfAccount(tx: Queryable, accountId: string): Promise<number> {
  return repo.deleteProfileOfAccount(tx, accountId);
}

/** The export (#51): the profile as written, or null. */
export async function exportProfile(
  db: Queryable,
  accountId: string,
): Promise<ProfileDocument | null> {
  const row = await repo.findProfile(db, accountId);
  return row ? toDocument(row) : null;
}
