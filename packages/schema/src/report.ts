import { z } from "zod";
import { SanctionReason } from "./sanction.ts";

// Reports and blocks (#84, ADR-030): a person blocks somebody whose card they
// were shown, or reports them with a reason of #106's list, which blocks too.
// Neither answer says anything about the other person, and nothing here ever
// carries the other person's id back.

/** A reporter's own words, trimmed; held to this length by the database too. */
export const REPORT_NOTE_MAX = 500;

/** What a moderator decided (#312); a report waiting for one has none. Mirrors the database's enum. */
export const ReportOutcome = z.enum(["dismissed", "acted"]).meta({ id: "ReportOutcome" });
export type ReportOutcome = z.infer<typeof ReportOutcome>;

/** Block the person of a card one was shown: from then on neither is shown to the other. */
export const BlockRequest = z
  .object({
    accountId: z.uuid().meta({ description: "The account of the card the person was shown." }),
  })
  .strict()
  .meta({ id: "BlockRequest" });
export type BlockRequest = z.infer<typeof BlockRequest>;

/**
 * Report the person of a card one was shown: a reason from the closed list
 * and, if the person likes, a few lines for the moderators. The app leaves a
 * blank note out. The report blocks both ways as well.
 */
export const ReportRequest = z
  .object({
    accountId: z.uuid().meta({ description: "The account of the card the person was shown." }),
    reason: SanctionReason,
    note: z.string().trim().min(1).max(REPORT_NOTE_MAX).optional(),
  })
  .strict()
  .meta({ id: "ReportRequest" });
export type ReportRequest = z.infer<typeof ReportRequest>;

/**
 * Report the other person of a conversation (#351, ADR-030 §12), whom the
 * conversation names: the card's reason and note. The report freezes a copy
 * of the conversation for the moderators, blocks both ways and closes it.
 */
export const ConversationReportRequest = ReportRequest.omit({ accountId: true })
  .strict()
  .meta({ id: "ConversationReportRequest" });
export type ConversationReportRequest = z.infer<typeof ConversationReportRequest>;

/**
 * A report in the reporter's own export (ADR-007, ADR-030 §8): when, why, their
 * own words and what came of it, in words in the request's language too;
 * never whom it was about.
 */
export const ExportedReport = z
  .object({
    at: z.iso.datetime(),
    reason: SanctionReason,
    reasonInWords: z.string(),
    note: z.string().max(REPORT_NOTE_MAX).nullable(),
    /** Null while it waits for a moderator. */
    outcome: ReportOutcome.nullable(),
    outcomeInWords: z.string(),
    decidedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "ExportedReport" });
export type ExportedReport = z.infer<typeof ExportedReport>;

export const ExportedReports = z
  .object({
    about: z.string().meta({ description: "What this part is, in the request's language." }),
    /** The reports the person filed, newest first, at most 1000. */
    items: z.array(ExportedReport).max(1000),
  })
  .meta({ id: "ExportedReports" });
export type ExportedReports = z.infer<typeof ExportedReports>;

export const ExportedBlocks = z
  .object({
    about: z.string().meta({ description: "What this part is, in the request's language." }),
    /** The blocks the person set, by date only, newest first, at most 1000. */
    items: z.array(z.object({ at: z.iso.datetime() })).max(1000),
  })
  .meta({ id: "ExportedBlocks" });
export type ExportedBlocks = z.infer<typeof ExportedBlocks>;
