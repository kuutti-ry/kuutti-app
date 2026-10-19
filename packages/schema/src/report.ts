import { z } from "zod";
import { SanctionReason } from "./sanction.ts";

// Reports and blocks (#84, ADR-030): a person blocks somebody whose card they
// were shown, or reports them with a reason of #106's list, which blocks too.
// Neither answer says anything about the other person, and nothing here ever
// carries the other person's id back.

/** A reporter's own words, trimmed; held to this length by the database too. */
export const REPORT_NOTE_MAX = 500;

/** Where a report was made: a card, or a conversation with its frozen copy (#351). Mirrors the database's enum. */
export const ReportSource = z.enum(["card", "conversation"]).meta({ id: "ReportSource" });
export type ReportSource = z.infer<typeof ReportSource>;

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
    /** From a card or from a conversation (#351); the conversation's copy is in nobody's export. */
    source: ReportSource,
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

/** The panel's report queue (#311): the reports waiting for a moderator, or those decided, for the record. */
export const ReportQueueQuery = z
  .object({
    state: z.enum(["open", "closed"]).default("open"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .meta({ id: "ReportQueueQuery" });
export type ReportQueueQuery = z.infer<typeof ReportQueueQuery>;

/**
 * One report as the queue lists it (#311, TD-5): why, where and when it was
 * made, and both people by account id with how they have figured in reports
 * before; never the reporter's note or anything of a conversation, which are
 * read on opening the report (#312, an audit row). The counts leave out every
 * report the reading member of staff is a party to (ADR-030 §6).
 */
export const ReportListItem = z
  .object({
    id: z.uuid(),
    reason: SanctionReason,
    source: ReportSource,
    createdAt: z.iso.datetime(),
    /** Null while it waits for a moderator. */
    outcome: ReportOutcome.nullable(),
    decidedAt: z.iso.datetime().nullable(),
    reporter: z.object({
      accountId: z.uuid(),
      /** The reports this account filed, this one included. */
      filed: z.int().min(0),
      /** Of those, the ones a moderator acted on. */
      upheld: z.int().min(0),
    }),
    reported: z.object({
      accountId: z.uuid(),
      /** The reports filed about this account, this one included. */
      received: z.int().min(0),
      /** The sanctions this account has had, lifted ones included (#307). */
      sanctions: z.int().min(0),
    }),
  })
  .meta({ id: "ReportListItem" });
export type ReportListItem = z.infer<typeof ReportListItem>;

/**
 * A page of the queue: open reports the oldest first, those about one person
 * together, the group whose oldest waited longest first; closed ones the
 * newest decision first. The API's clock and the response time promised
 * (#299) ride along, as on the front page.
 */
export const ReportQueue = z
  .object({
    now: z.iso.datetime(),
    /** matching_config moderation_response_hours: past it, an open report is late. */
    responseHours: z.number().min(0),
    items: z.array(ReportListItem).max(100),
    /** Reports in this state in total, beyond this page. */
    total: z.int().min(0),
  })
  .meta({ id: "ReportQueue" });
export type ReportQueue = z.infer<typeof ReportQueue>;
