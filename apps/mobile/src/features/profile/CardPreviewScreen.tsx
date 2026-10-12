import type { CardPreviewResponse } from "@kuutti/schema";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { fetchCardPreview } from "./client";
import { completenessText } from "./keys";
import { ProfileCardView } from "./ProfileCardView";

type State =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; preview: CardPreviewResponse };

/** The owner looking at their own card (#47): built the way a round builds it, nothing recorded. */
export function CardPreviewScreen() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const [state, setState] = useState<State>({ status: "loading" });
  // A photo URL the API refused (the day's budget, #52): said under the card, never a silent gap.
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

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="flex-grow gap-4 p-6">
        <Button
          variant="ghost"
          onPress={() => {
            tap();
            router.back();
          }}
        >
          {t("profile.card.back")}
        </Button>
        <Text variant="h1" accessibilityRole="header">
          {t("profile.card.title")}
        </Text>
        <Text>{t("profile.card.explain")}</Text>
        {state.status === "loading" && (
          <Text accessibilityLiveRegion="polite">{t("profile.card.loading")}</Text>
        )}
        {state.status === "error" && (
          <LoadFailed
            headline={t("profile.card.failed")}
            error={state.error}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        )}
        {state.status === "ready" && !state.preview.card && <Text>{t("profile.card.empty")}</Text>}
        {state.status === "ready" && state.preview.card && (
          <ProfileCardView
            card={state.preview.card}
            onRefused={(code) => setRefusal(code ?? "unknown")}
          />
        )}
        {refusal !== null && (
          <Text variant="muted" accessibilityLiveRegion="polite">
            {t(
              refusal === "photo_budget_exceeded"
                ? "photos.error.photo_budget_exceeded"
                : "photos.error.generic",
            )}
          </Text>
        )}
        {state.status === "ready" && !state.preview.completeness.complete && (
          <View className="gap-1">
            <Text variant="small">{t("profile.completeness.title")}</Text>
            {state.preview.completeness.missing.map((item) => (
              <Text key={item} variant="muted">
                {completenessText(t, item)}
              </Text>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
