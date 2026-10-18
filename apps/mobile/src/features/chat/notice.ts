import type { PlainMessageKey } from "@kuutti/i18n";
import type { SafetyOutcome } from "@/features/safety";

/** What the list says after a report, a block or an end from a conversation (#351). */
export const NOTICES: Record<SafetyOutcome, PlainMessageKey> = {
  reported: "safety.report.done",
  blocked: "safety.block.done",
  unmatched: "chat.unmatch.done",
  gone: "chat.notice.gone",
};

/**
 * What a report, a block or an end left to say (#351): the conversation hands
 * the person back to the list, which says it once. Held here between the two
 * screens, not in the route, so a link to the list never carries it and a
 * later visit does not say it again.
 */
let left: SafetyOutcome | null = null;

export function leaveNotice(outcome: SafetyOutcome): void {
  left = outcome;
}

/** The notice left for the list, once: a second take finds none. */
export function takeNotice(): SafetyOutcome | null {
  const notice = left;
  left = null;
  return notice;
}
