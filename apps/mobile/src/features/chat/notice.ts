import type { PlainMessageKey } from "@kuutti/i18n";
import { useRouter } from "expo-router";
import { AccessibilityInfo } from "react-native";
import type { SafetyOutcome } from "@/features/safety";
import { useT } from "@/lib/locale";

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

/**
 * A report, a block or an end went through from a conversation or from one of
 * its photos (#476), or the conversation was gone: back to the list, which
 * says so. One that lands after the person left the screen (not `inFront`)
 * moves nobody (a dismissTo from elsewhere would replace the screen they are
 * on) and is announced instead, on both platforms, since nothing on their
 * screen says it.
 */
export function useHandToList(): (outcome: SafetyOutcome, inFront: boolean) => void {
  const { t } = useT();
  const router = useRouter();
  return (outcome, inFront) => {
    if (!inFront) {
      AccessibilityInfo.announceForAccessibility(t(NOTICES[outcome]));
      return;
    }
    leaveNotice(outcome);
    router.dismissTo("/chats");
  };
}
