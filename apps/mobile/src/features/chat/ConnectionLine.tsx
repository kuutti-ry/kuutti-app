import { useEffect } from "react";
import { AccessibilityInfo, Platform } from "react-native";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useChatLive } from "./store";

/**
 * One line at the top of the chat's screens while the socket is lost (#349):
 * it was open and closed, or the tries keep failing. Said politely, once; it
 * goes when the socket is open again. iOS has no live regions, so VoiceOver
 * is told when the line appears; TalkBack reads the region itself.
 */
export function ConnectionLine() {
  const { t } = useT();
  const { status } = useChatLive();
  const lost = status === "lost";
  const words = t("chat.connection.lost");
  useEffect(() => {
    if (lost && Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(words);
  }, [lost, words]);
  if (!lost) return null;
  return (
    <Text accessibilityLiveRegion="polite" className="border-b border-border px-6 py-2">
      {words}
    </Text>
  );
}
