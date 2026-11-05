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
import { sayAloud } from "@/components/Notice";
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
import { ContactMark } from "./ContactMark";
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

/**
 * The share dialog of a conversation (#103): the contacts the person keeps,
 * each as its kind and value with a Share or a Stop sharing button (a button,
 * never a switch), whose word is the state and whose spoken label names the
 * contact (#581). The sentence under the title says the other person sees it at
 * once and that what they wrote down stays with them; nothing is asked back.
 * Each press answers the person's fresh view of the conversation, handed to the
 * screen: the button turns and a screen reader is told, with nothing drawn
 * (#581). A refusal is said in words, and one that means the view is out of date
 * (the piece removed on another phone, the conversation ended or gone) has the
 * screen read it again. In a conversation that ended while the dialog was open,
 * the ending is said instead of the buttons. An outcome that comes after the
 * dialog closed is not said: it would be stale the next time it opens, which
 * shows what the press changed anyway. The focus moves to the title as it opens;
 * a refusal's live region speaks on Android, and iOS, which has none, is told. A
 * value is shown, never put in a label.
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
  const [refusal, setRefusal] = useState<PlainMessageKey | null>(null);
  const isOpen = useRef(open);
  useEffect(() => {
    isOpen.current = open;
  }, [open]);

  // The title as the dialog opens: the button that opened it is under the scrim.
  const focusTitle = useCallback((node: TextNode | null) => {
    if (node) AccessibilityInfo.sendAccessibilityEvent(node, "focus");
  }, []);

  const press = async (kind: ContactKind, shared: boolean) => {
    tap();
    setRefusal(null);
    setBusy(true);
    try {
      onDetail(
        shared ? await stopSharing(conversationId, kind) : await shareContact(conversationId, kind),
      );
      // The button turns, and the sentence under the title says the rest: said, not drawn (#581).
      if (isOpen.current) {
        sayAloud(
          shared ? t("chat.contact.share.stopped") : t("chat.contact.share.shared", { name }),
        );
      }
    } catch (error) {
      const code = (error instanceof ApiError ? error.code : undefined) ?? "";
      if (isOpen.current) {
        const refused = REFUSALS.get(code) ?? "load.failed.press";
        setRefusal(refused);
        // iOS has no live regions; Android's speaks the same words already.
        if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(t(refused));
      }
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
        setRefusal(null);
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
                <View className="flex-row items-center gap-2">
                  <ContactMark kind={kind} />
                  <Text className="flex-1">{t("chat.contact.piece", { kind, value })}</Text>
                </View>
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
          {refusal && <Text accessibilityLiveRegion="assertive">{t(refusal)}</Text>}
        </ScrollView>
      </DialogContent>
    </Dialog>
  );
}
