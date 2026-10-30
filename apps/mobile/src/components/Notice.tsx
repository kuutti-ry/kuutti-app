import { useEffect } from "react";
import { AccessibilityInfo, Platform } from "react-native";
import { Text } from "@/components/ui/text";

/**
 * What came of a change, said where it happened (#511): in a live region,
 * which Android and the web read, polite for what was done and assertive for
 * what was refused; and aloud on iOS, which has no live regions, queued
 * behind what is being said, since leaving a field moves the focus at the
 * same moment. `answer` counts the answers, so the same words said again for
 * a second answer are heard again.
 */
export function Notice({
  words,
  refused = false,
  answer = 0,
}: {
  words: string;
  refused?: boolean;
  answer?: number;
}) {
  // A new answer with the same words is said again, hence the answer among the dependencies.
  useEffect(() => {
    if (Platform.OS === "ios") {
      AccessibilityInfo.announceForAccessibilityWithOptions(words, { queue: true });
    }
  }, [words, answer]);
  return (
    <Text key={answer} accessibilityLiveRegion={refused ? "assertive" : "polite"}>
      {words}
    </Text>
  );
}
