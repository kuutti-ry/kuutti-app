import type { PlainMessageKey } from "@kuutti/i18n";
import type { ReportOutcome, ReportSource, SanctionReason } from "@kuutti/schema";

// A report's values in words (#311, #312), the same on the queue and on one
// report's page, so the two screens never say one report two ways.

export const REASON: Record<SanctionReason, PlainMessageKey> = {
  harassment: "admin.sanction.reason.harassment",
  misrepresentation: "admin.sanction.reason.misrepresentation",
  under_age: "admin.sanction.reason.under_age",
  commercial_use: "admin.sanction.reason.commercial_use",
  scraping: "admin.sanction.reason.scraping",
  other: "admin.sanction.reason.other",
};

export const SOURCE: Record<ReportSource, PlainMessageKey> = {
  card: "admin.reports.source.card",
  conversation: "admin.reports.source.conversation",
};

export const OUTCOME: Record<ReportOutcome, PlainMessageKey> = {
  dismissed: "admin.reports.outcome.dismissed",
  acted: "admin.reports.outcome.acted",
};
