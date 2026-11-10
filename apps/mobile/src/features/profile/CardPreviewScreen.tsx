import type { CardPreviewResponse } from "@kuutti/schema";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Text } from "@/components/ui/text";
import { photoRefusalKey } from "@/features/media";
import { useT } from "@/lib/locale";
import { fetchCardPreview } from "./client";
import { completenessText } from "./keys";
import { ProfileCardView } from "./ProfileCardView";

type State =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; preview: CardPreviewResponse };

/**
 * The owner looking at their own card (#47): built the way a round builds it,
 * nothing recorded. What it still needs stands above it, as on the profile, and
 * a card can be called what others see only once nothing is missing (#581).
 */
export function CardPreviewScreen() {
  const { t } = useT();
  const [state, setState] = useState<State>({ status: "loading" });
  // A photo URL the API refused (the day's budget, #52): said under the card, never a
  // silent gap; anything else is a photo not shown, never an upload (#235).
  const [refusal, setRefusal] = useState<string | null>(null);
  // Bumped by "Try again": the read runs again.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    fetchCardPreview()
      .then((preview) => live && setState({ status: "ready", preview }))
      .catch((error: unknown) => live && setState({ status: "error", error }));
    return () => {
      live = false;
    };
  }, [attempt]);
  const preview = state.status === "ready" ? state.preview : null;

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader title={t("profile.card.title")} backLabel={t("profile.card.back")} />
      <ScrollView contentContainerClassName="flex-grow gap-4 p-6">
        {state.status === "loading" && (
          <Text accessibilityLiveRegion="polite">{t("load.loading")}</Text>
        )}
        {state.status === "error" && (
          <LoadFailed error={state.error} onRetry={() => setAttempt((n) => n + 1)} />
        )}
        {preview && !preview.completeness.complete && (
          <View className="gap-1">
            <Text variant="small">{t("profile.completeness.title")}</Text>
            {preview.completeness.missing.map((item) => (
              <Text key={item} variant="muted">
                {completenessText(t, item)}
              </Text>
            ))}
          </View>
        )}
        {preview?.card && preview.completeness.complete && <Text>{t("profile.card.explain")}</Text>}
        {preview?.card && (
          <ProfileCardView
            card={preview.card}
            onRefused={(code) => setRefusal(code ?? "unknown")}
          />
        )}
        {refusal !== null && (
          <Text variant="muted" accessibilityLiveRegion="polite">
            {t(photoRefusalKey(refusal))}
          </Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
