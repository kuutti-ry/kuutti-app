import type { PlainMessageKey } from "@kuutti/i18n";
import type { ContactKind, ConversationContacts, ConversationDetail } from "@kuutti/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Platform,
  ScrollView,
  type Text as TextNode,
  useWindowDimensions,
  View,
} from "react-native";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Text } from "@/components/ui/text";
import { ApiError } from "@/lib/api";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { shareContact, stopSharing } from "./client";

/**
 * The refusals the dialog says in its own words; anything else is a failure
 * to try again. A Map, so a code like `toString` finds nothing.
 */
const REFUSALS: ReadonlyMap<string, PlainMessageKey> = new Map([
  ["contact_not_stored", "errors.contact_not_stored"],
  ["conversation_closed", "chat.contact.error.conversation_closed"],
  ["not_found", "chat.conversation.gone"],
  ["message_budget_exceeded", "chat.contact.error.message_budget_exceeded"],
]);

/**
 * The refusals that say what the screen shows is out of date: the piece was
 * removed on another phone, the conversation ended or went. The screen reads
 * it again.
 */
const STALE: ReadonlySet<string> = new Set([
  "contact_not_stored",
  "conversation_closed",
  "not_found",
]);

/** The dialog is bounded by the window, so its middle scrolls rather than overflows (2x text). */
const WINDOW_SHARE = 0.9;

type Notice = { kind: "shared" } | { kind: "stopped" } | { kind: "refused"; key: PlainMessageKey };

/**
 * The share dialog of a conversation (#103): the contacts the person keeps,
 * each as its kind and value with a Share or a Stop sharing button (a button,
 * never a switch), and "Shared in this conversation" under one that is. The
 * sentence under the title says the other person sees it at once and that
 * what they wrote down stays with them; nothing is asked back. Each press
 * answers the person's fresh view of the conversation, handed to the screen;
 * the outcome or the refusal is said in words, and a refusal that means the
 * view is out of date (the piece removed on another phone, the conversation
 * ended or gone) has the screen read it again. In a conversation that ended
 * while the dialog was open, the ending is said instead of the buttons. An
 * outcome that comes after the dialog closed is not said: it would be stale
 * the next time it opens, which shows what the press changed anyway. The
 * focus moves to the title as it opens; live regions speak on Android, and
 * iOS, which has none, is told. A value is shown, never put in a label.
 */
export function ContactShare({
  conversationId,
  contacts,
  closed,
  name,
  open,
  onClose,
  onDetail,
  onStale,
}: {
  conversationId: string;
  contacts: ConversationContacts;
  /** The conversation ended: nothing more to share. */
  closed: boolean;
  /** The other person, as the header says them, without the age. */
  name: string;
  open: boolean;
  /** The corner's Close, the scrim, the back gesture. */
  onClose: () => void;
  /** The person's fresh view of the conversation, as the API answered a share or a stop. */
  onDetail: (detail: ConversationDetail) => void;
  /** A refusal that says the view is out of date: the screen reads the conversation again. */
  onStale: () => void;
}) {
  const { t } = useT();
  const tap = useHapticTap();
  const { height } = useWindowDimensions();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const isOpen = useRef(open);
  useEffect(() => {
    isOpen.current = open;
  }, [open]);

  // The title as the dialog opens: the button that opened it is under the scrim.
  const focusTitle = useCallback((node: TextNode | null) => {
    if (node) AccessibilityInfo.sendAccessibilityEvent(node, "focus");
  }, []);

  const words = (said: Notice): string =>
    said.kind === "shared"
      ? t("chat.contact.share.shared", { name })
      : said.kind === "stopped"
        ? t("chat.contact.share.stopped")
        : t(said.key);

  const tell = (said: Notice) => {
    if (!isOpen.current) return;
    setNotice(said);
    // iOS has no live regions; Android's speak the same words already.
    if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(words(said));
  };

  const press = async (kind: ContactKind, shared: boolean) => {
    tap();
    setNotice(null);
    setBusy(true);
    try {
      onDetail(
        shared ? await stopSharing(conversationId, kind) : await shareContact(conversationId, kind),
      );
      tell({ kind: shared ? "stopped" : "shared" });
    } catch (error) {
      const code = (error instanceof ApiError ? error.code : undefined) ?? "";
      tell({ kind: "refused", key: REFUSALS.get(code) ?? "chat.contact.error.failed" });
      if (STALE.has(code)) onStale();
    } finally {
      setBusy(false);
    }
  };

  return (
    // Nothing but the header's button opens it, so a change is always a close;
    // what was said belongs to the time the dialog was open.
    <Dialog
      open={open}
      onOpenChange={() => {
        setNotice(null);
        onClose();
      }}
    >
      <DialogContent
        closeLabel={t("chat.contact.share.close")}
        style={{ maxHeight: height * WINDOW_SHARE }}
      >
        <DialogHeader>
          <DialogTitle ref={focusTitle}>{t("chat.contact.share.title")}</DialogTitle>
        </DialogHeader>
        <ScrollView style={{ flexShrink: 1 }} contentContainerClassName="gap-4">
          <DialogDescription>{t("chat.contact.share.body", { name })}</DialogDescription>
          {closed ? (
            <Text>{t("chat.state.ended")}</Text>
          ) : (
            contacts.mine.map(({ kind, value, shared }) => (
              <View key={kind} className="gap-2">
                <Text>{t("chat.contact.piece", { kind, value })}</Text>
                {shared && <Text variant="muted">{t("chat.contact.share.sharedHere")}</Text>}
                {shared ? (
                  <Button
                    variant="outline"
                    disabled={busy}
                    accessibilityLabel={t("chat.contact.share.stopLabel", { kind })}
                    onPress={() => void press(kind, true)}
                  >
                    {t("chat.contact.share.stop")}
                  </Button>
                ) : (
                  <Button
                    disabled={busy}
                    accessibilityLabel={t("chat.contact.share.shareLabel", { kind })}
                    onPress={() => void press(kind, false)}
                  >
                    {t("chat.contact.share.share")}
                  </Button>
                )}
              </View>
            ))
          )}
          {notice && (
            <Text accessibilityLiveRegion={notice.kind === "refused" ? "assertive" : "polite"}>
              {words(notice)}
            </Text>
          )}
        </ScrollView>
      </DialogContent>
    </Dialog>
  );
}
