import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { readPreference, writePreference } from "@/lib/preferences";
import { useHapticTap } from "@/theme/haptics";
import { usePhonePermission } from "./usePhonePermission";

/**
 * The home screen's one offer of notifications (#102, ADR-055 §9), beside
 * the way to today's round once matching is open, never at the first start:
 * the reason in words and two answers of equal weight. Allow shows the
 * phone's own question; No thanks leaves it unasked. Both wait from a tap
 * until the answer is in, so a second tap asks nothing. Either answer is kept
 * on this phone (`pushAsked`) and the offer never comes back; Settings ›
 * Notifications can still ask. Shown only while the phone has not been asked,
 * so never on the web target.
 */
export function PushOffer() {
  // Null until read; a preference that cannot be read reads as never answered.
  const [answered, setAnswered] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void readPreference("pushAsked").then((stored) => live && setAnswered(stored !== null));
    return () => {
      live = false;
    };
  }, []);
  if (answered !== false) return null;
  return <Offer onAnswered={() => setAnswered(true)} />;
}

function Offer({ onAnswered }: { onAnswered: () => void }) {
  const { t } = useT();
  const tap = useHapticTap();
  const { permission, ask } = usePhonePermission();
  const [pending, setPending] = useState(false);
  if (permission !== "undetermined") return null;

  // Kept before the phone's question, so that an app closed under it does not offer again.
  // Pending to the end: the answer takes the offer away.
  const answer = async (allow: boolean) => {
    tap();
    setPending(true);
    await writePreference("pushAsked", "true");
    if (allow) await ask();
    onAnswered();
  };

  return (
    <View className="mt-4 gap-2">
      <Text variant="large" accessibilityRole="header">
        {t("notifications.ask.heading")}
      </Text>
      <Text>{t("notifications.ask.body")}</Text>
      <Button variant="outline" disabled={pending} onPress={() => void answer(true)}>
        {t("notifications.allow")}
      </Button>
      <Button variant="outline" disabled={pending} onPress={() => void answer(false)}>
        {t("notifications.ask.decline")}
      </Button>
    </View>
  );
}
