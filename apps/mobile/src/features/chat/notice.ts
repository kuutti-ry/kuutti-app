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
 *
 * From one of a conversation's photos (`photoOf`, the conversation's id), the
 * hand goes down to that conversation first (#491). dismissTo replaces the
 * screen it starts from when the list is not under it, as for a conversation
 * opened from the match screen: from the photo, that left the reported
 * conversation under the list, where Back found it no longer available. Down
 * to the conversation by its route, not one step back, a photo a quick double
 * tap pushed twice goes too, and a photo an outside link opened, with no
 * conversation under it, is replaced as before. expo-router runs the two in
 * order, each on the state the one before left.
 */
export function useHandToList(
  photoOf?: string,
): (outcome: SafetyOutcome, inFront: boolean) => void {
  const { t } = useT();
  const router = useRouter();
  return (outcome, inFront) => {
    if (!inFront) {
      AccessibilityInfo.announceForAccessibility(t(NOTICES[outcome]));
      return;
    }
    leaveNotice(outcome);
    if (photoOf !== undefined) {
      router.dismissTo({ pathname: "/chats/[id]", params: { id: photoOf } });
    }
    router.dismissTo("/chats");
  };
}
