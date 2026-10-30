import type { ContactKind, ConversationContacts } from "@kuutti/schema";
import { useEffect, useRef, useState } from "react";
// shortcut: React Native's own Clipboard is deprecated and goes in a later
// release, but 0.86 ships it with its native side, so Copy needs no new build;
// expo-clipboard in the next native batch (#184) lifts it.
import {
  AccessibilityInfo,
  Clipboard,
  Linking,
  Platform,
  ScrollView,
  useWindowDimensions,
  View,
} from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { ContactMark } from "./ContactMark";
import { contactLink } from "./contactLink";

const keyOf = ({ kind, value }: ConversationContacts["theirs"][number]) => `${kind} ${value}`;

type Notice = { said: "copied"; kind: ContactKind } | { said: "refused" };

/** The lines scroll within this much of the window: at 2x text five would push the conversation off it. */
const WINDOW_SHARE = 1 / 3;

/**
 * What the other person shares with the reader now (#103), under the
 * conversation's header: one line each, the service's mark (decorative) and
 * its kind and value as text that can be selected, heard as who shares what
 * ("Ville shares Instagram: ville.k"), with Open (Call for a number) and Copy
 * beside it, or below it where the line has no room (#473). Open goes where
 * contactLink says and is left out where it says nowhere. Neither button
 * tells Kuutti or the sharer anything, and neither names the value. A line
 * that appears while the screen is open is said without moving the focus:
 * TalkBack reads the region, and VoiceOver, iOS having no live regions, is
 * told. What was there when the screen opened is not said again. A copy and
 * an open the phone refused are said the same way, in a line of their own
 * below the lines, so that it stays in sight and TalkBack reads the words
 * alone, until the next press.
 */
export function SharedContacts({
  name,
  theirs,
}: {
  /** The other person, as the header says them, without the age. */
  name: string;
  theirs: ConversationContacts["theirs"];
}) {
  const { t } = useT();
  const tap = useHapticTap();
  const { height } = useWindowDimensions();
  const [notice, setNotice] = useState<Notice | null>(null);
  const seen = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const before = seen.current;
    seen.current = new Set(theirs.map(keyOf));
    if (!before || Platform.OS !== "ios") return;
    for (const piece of theirs) {
      if (!before.has(keyOf(piece))) {
        AccessibilityInfo.announceForAccessibility(
          t("chat.contact.theirs", { kind: piece.kind, name, value: piece.value }),
        );
      }
    }
  }, [theirs, name, t]);

  const words = (said: Notice): string =>
    said.said === "copied"
      ? t("chat.contact.copied", { kind: said.kind })
      : t("chat.contact.openRefused");

  const tell = (said: Notice) => {
    setNotice(said);
    // iOS has no live regions; Android's speak the same words already.
    if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(words(said));
  };

  const open = async (link: string) => {
    tap();
    setNotice(null);
    // A refusal goes in no log: its message carries the address, so the value.
    // The simulator answers false to a `tel:` instead of refusing.
    const opened = await Linking.openURL(link).catch(() => false);
    if (opened === false) tell({ said: "refused" });
  };

  const copy = (kind: ContactKind, value: string) => {
    tap();
    Clipboard.setString(value);
    tell({ said: "copied", kind });
  };

  return (
    <View className={theirs.length > 0 ? "gap-1 border-b border-border px-6 py-2" : undefined}>
      <ScrollView style={{ flexGrow: 0, maxHeight: height * WINDOW_SHARE }}>
        <View accessibilityLiveRegion="polite" className="gap-1">
          {theirs.map(({ kind, value }) => {
            const link = contactLink(kind, value);
            return (
              <View key={kind} className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
                {/* shrink and never grow: Yoga takes a lone child that does both for width 0, and the buttons would never wrap. */}
                <View className="shrink flex-row items-center gap-2">
                  <ContactMark kind={kind} />
                  <Text
                    selectable
                    className="shrink"
                    accessibilityLabel={t("chat.contact.theirs", { kind, name, value })}
                  >
                    {t("chat.contact.piece", { kind, value })}
                  </Text>
                </View>
                <View className="ml-auto flex-row flex-wrap gap-2">
                  {link && (
                    <Button
                      variant="outline"
                      accessibilityRole="link"
                      accessibilityLabel={t("chat.contact.openLabel", { kind, name })}
                      className="px-3"
                      onPress={() => void open(link)}
                    >
                      {t("chat.contact.open", { kind })}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    accessibilityLabel={t("chat.contact.copyLabel", { kind, name })}
                    className="px-3"
                    onPress={() => copy(kind, value)}
                  >
                    {t("chat.contact.copy")}
                  </Button>
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>
      {notice && theirs.length > 0 && (
        <Text accessibilityLiveRegion={notice.said === "refused" ? "assertive" : "polite"}>
          {words(notice)}
        </Text>
      )}
    </View>
  );
}
