import type { ConversationContacts } from "@kuutti/schema";
import { useEffect, useRef } from "react";
import { AccessibilityInfo, Platform, View } from "react-native";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";

const keyOf = ({ kind, value }: ConversationContacts["theirs"][number]) => `${kind} ${value}`;

/**
 * What the other person shares with the reader now (#103), under the
 * conversation's header: one line each, its kind and value as text that can
 * be selected and copied, never a link; heard as who shares what ("Ville
 * shares Instagram: ville.k"). A line that appears while the screen is open
 * is said without moving the focus: TalkBack reads the region, and VoiceOver,
 * iOS having no live regions, is told. What was there when the screen opened
 * is not said again.
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

  return (
    <View
      accessibilityLiveRegion="polite"
      className={theirs.length > 0 ? "gap-1 border-b border-border px-6 py-2" : undefined}
    >
      {theirs.map(({ kind, value }) => (
        <Text
          key={kind}
          selectable
          accessibilityLabel={t("chat.contact.theirs", { kind, name, value })}
        >
          {t("chat.contact.piece", { kind, value })}
        </Text>
      ))}
    </View>
  );
}
