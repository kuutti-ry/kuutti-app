import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { DealBreakerRows, useDealBreakers } from "./DealBreakerRows";
import { useProfile } from "./useProfile";

/**
 * The deal-breakers' rows alone, for the e-mail screen's door at the end of the
 * later questions (#149, #551); What you seek has the same rows under its own.
 * Reads everything again when a deal-breaker's screen hands back.
 */
export function DealBreakersScreen() {
  const { t } = useT();
  const router = useRouter();
  const profile = useProfile();
  const { reload } = profile;
  const [response, readDealBreakers] = useDealBreakers();
  // The first focus is the mount, which the hook reads already.
  const shown = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (shown.current) void reload();
      shown.current = true;
      readDealBreakers();
    }, [reload, readDealBreakers]),
  );

  if (profile.status === "loading") {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center p-6">
          <Text accessibilityLiveRegion="polite">{t("profile.loading")}</Text>
        </View>
      </SafeAreaView>
    );
  }
  if (profile.status === "error") {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center gap-4 p-6">
          <LoadFailed
            headline={t("profile.failed")}
            error={profile.error}
            onRetry={() => {
              readDealBreakers();
              void reload();
            }}
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader
        title={t("profile.dealBreakers.title")}
        backLabel={t("profile.dealBreakers.back")}
        onBack={() => router.back()}
      />
      <ScrollView contentContainerClassName="flex-grow gap-6 p-6">
        <DealBreakerRows response={response} own={profile.saved.fields} />
      </ScrollView>
    </SafeAreaView>
  );
}
