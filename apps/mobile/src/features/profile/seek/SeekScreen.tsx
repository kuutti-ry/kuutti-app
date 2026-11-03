import { GENDERS } from "@kuutti/schema";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { RowGroup } from "@/components/RowGroup";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { DealBreakerRows, useDealBreakers } from "../DealBreakerRows";
import { optionKey, seeksKey } from "../keys";
import { INTENT_SECTION, sectionPath } from "../sections";
import { SEEK_AGES_PATH } from "./SeekAgesScreen";
import { SEEK_WHOM_PATH } from "./SeekWhomScreen";
import { useSeeking } from "./useSeeking";

export const SEEK_PATH = "/profile/seek" as const;

/**
 * What a person seeks, as a list of its own (#542), built like the profile's
 * and the settings': each row its answer, opening a screen of its own, and
 * nothing edited here. Whom, the ages and what one is here for under
 * onboarding's own questions, then a row per deal-breaker under a heading
 * (#551), so the list reflects what a person has shared. Every answer is a
 * filter both ways, which the line at the top says, naming no moment: a change
 * works on the next read (ADR-062 §8). Reached from the profile and from the
 * queue's end (§11), not Home, so its way back names neither. The list reads
 * everything again when a screen hands back.
 */
export function SeekScreen() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const seeking = useSeeking();
  const { reload } = seeking;
  const [dealBreakers, readDealBreakers] = useDealBreakers();
  // The first focus is the mount, which the hook reads already.
  const shown = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (shown.current) void reload();
      shown.current = true;
      readDealBreakers();
    }, [reload, readDealBreakers]),
  );
  const open = (path: Parameters<typeof router.push>[0]) => () => {
    tap();
    router.push(path);
  };

  if (seeking.status === "loading") {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center p-6">
          <Text accessibilityLiveRegion="polite">{t("profile.loading")}</Text>
        </View>
      </SafeAreaView>
    );
  }
  if (seeking.status === "error") {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center gap-4 p-6">
          <LoadFailed
            headline={t("profile.failed")}
            error={seeking.error}
            onRetry={() => {
              readDealBreakers();
              void reload();
            }}
          />
        </View>
      </SafeAreaView>
    );
  }

  const { seeks, ageWindow, fields } = seeking.seeking;
  const whom =
    seeks.length === GENDERS.length
      ? t("onboarding.seeks.anyone")
      : GENDERS.filter((gender) => seeks.includes(gender))
          .map((gender) => t(seeksKey(gender)))
          .join(", ");
  const ages = t("profile.seek.ages.summary", ageWindow);
  const here = fields.intent && t(optionKey("intent", fields.intent));

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader
        title={t("profile.seek.title")}
        backLabel={t("profile.back")}
        onBack={() => router.back()}
      />
      <ScrollView contentContainerClassName="flex-grow gap-6 p-6">
        <Text>{t("profile.seek.explain")}</Text>
        {/* Each answer is the row's state: drawn under the title, heard once, as its value. */}
        <RowGroup
          rows={[
            {
              key: "whom",
              title: t("onboarding.seeks.title"),
              summary: whom,
              value: whom,
              onPress: open(SEEK_WHOM_PATH),
            },
            {
              key: "ages",
              title: t("onboarding.age.title"),
              summary: ages,
              value: ages,
              onPress: open(SEEK_AGES_PATH),
            },
            {
              key: "intent",
              title: t("onboarding.intent.title"),
              summary: here,
              value: here,
              onPress: open(sectionPath(INTENT_SECTION)),
            },
          ]}
        />
        <View className="gap-3">
          <Text variant="large" role="heading" aria-level="2">
            {t("profile.dealBreakers.title")}
          </Text>
          <DealBreakerRows response={dealBreakers} own={fields} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
