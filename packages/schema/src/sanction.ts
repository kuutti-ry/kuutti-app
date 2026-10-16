import { z } from "zod";
import { ModeratorRole } from "./admin.ts";

// Sanctions (#307, ADR-024): what a moderator or an admin may do to a person,
// why, and the record the panel reads. Mirrors of the database's enums
// (packages/db schema/safety.ts, held equal by schema-shape.test.ts).

export const SanctionKind = z
  .enum(["warn", "shadow_ban", "suspend", "ban"])
  .meta({ id: "SanctionKind" });
export type SanctionKind = z.infer<typeof SanctionKind>;

/** The closed list of reasons (#106; the maintainer's to change). */
export const SanctionReason = z
  .enum(["harassment", "misrepresentation", "under_age", "commercial_use", "scraping", "other"])
  .meta({ id: "SanctionReason" });
export type SanctionReason = z.infer<typeof SanctionReason>;

/** Staff's own words on a sanction or its review; held to this length by the database too. */
export const SANCTION_NOTE_MAX = 500;
/** A suspension ends at most this many days ahead; a longer exclusion is a ban (ADR-024 §5). */
export const SUSPENSION_DAYS_MAX = 366;

/** Staff's note, trimmed; the service parses it again, so no caller can hand the database a note it would refuse. */
export const SanctionNote = z.string().trim().min(1).max(SANCTION_NOTE_MAX);
const Note = SanctionNote;

/**
 * What a moderator applies from a person's page: a warning, a shadow ban, or a
 * suspension until a day in Finland (`endsOn`, `YYYY-MM-DD`, after today and at
 * most SUSPENSION_DAYS_MAX ahead). A ban has its own route, for admins.
 */
export const SanctionRequest = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("warn"), reason: SanctionReason, note: Note }).strict(),
    z.object({ kind: z.literal("shadow_ban"), reason: SanctionReason, note: Note }).strict(),
    z
      .object({
        kind: z.literal("suspend"),
        reason: SanctionReason,
        note: Note,
        endsOn: z.iso.date(),
      })
      .strict(),
  ])
  .meta({ id: "SanctionRequest" });
export type SanctionRequest = z.infer<typeof SanctionRequest>;

/** An admin's ban: on the identity, for good until an admin lifts it. */
export const BanRequest = z
  .object({ reason: SanctionReason, note: Note })
  .strict()
  .meta({ id: "BanRequest" });
export type BanRequest = z.infer<typeof BanRequest>;

/** A second member of staff's look at a sanction: a note, and keep it or lift it. */
export const SanctionReviewRequest = z
  .object({ note: Note, outcome: z.enum(["keep", "lift"]) })
  .strict()
  .meta({ id: "SanctionReviewRequest" });
export type SanctionReviewRequest = z.infer<typeof SanctionReviewRequest>;

export const SanctionParams = z.object({ id: z.uuid() }).meta({ id: "SanctionParams" });
export const SanctionAccountParams = z
  .object({ id: z.uuid() })
  .meta({ id: "SanctionAccountParams" });

/** One sanction as the panel reads it; staff by identity id, null for what no person did. */
export const Sanction = z
  .object({
    id: z.uuid(),
    accountId: z.uuid(),
    kind: SanctionKind,
    reason: SanctionReason,
    note: z.string().max(SANCTION_NOTE_MAX),
    endsAt: z.iso.datetime().nullable(),
    createdBy: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    liftedAt: z.iso.datetime().nullable(),
    liftedBy: z.uuid().nullable(),
    reviewNote: z.string().max(SANCTION_NOTE_MAX).nullable(),
    reviewedBy: z.uuid().nullable(),
    reviewedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "Sanction" });
export type Sanction = z.infer<typeof Sanction>;

/**
 * A sanction on a person's page (#308): who applied, lifted and looked at it
 * again by their role now as well, null once the role is gone or for what no
 * person did.
 */
export const SanctionEntry = Sanction.extend({
  createdByRole: ModeratorRole.nullable(),
  liftedByRole: ModeratorRole.nullable(),
  reviewedByRole: ModeratorRole.nullable(),
}).meta({ id: "SanctionEntry" });
export type SanctionEntry = z.infer<typeof SanctionEntry>;

/** A person's sanctions, newest first: the account's own and the identity's bans from any account. */
export const SanctionList = z
  .object({ items: z.array(SanctionEntry).max(1000) })
  .meta({ id: "SanctionList" });
export type SanctionList = z.infer<typeof SanctionList>;

/**
 * A sanction in the person's own export (ADR-024 §8): kind, reason and dates,
 * in words in the request's language too; never who, never staff's note. An
 * open shadow ban is not listed while it lasts (#105).
 */
export const ExportedSanction = z
  .object({
    kind: SanctionKind,
    kindInWords: z.string(),
    reason: SanctionReason,
    reasonInWords: z.string(),
    appliedAt: z.iso.datetime(),
    endsAt: z.iso.datetime().nullable(),
    liftedAt: z.iso.datetime().nullable(),
    lookedAtAgain: z
      .boolean()
      .meta({ description: "Whether a second member of staff reviewed it." }),
  })
  .meta({ id: "ExportedSanction" });
export type ExportedSanction = z.infer<typeof ExportedSanction>;
