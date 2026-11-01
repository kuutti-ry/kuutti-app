import { GENDERS, type StoredDealBreaker } from "@kuutti/schema";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { RowGroup } from "@/components/RowGroup";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { fetchDealBreakers } from "../client";
import { DEAL_BREAKERS_PATH } from "../DealBreakersScreen";
import { fieldLabelKey, optionKey, seeksKey } from "../keys";
import { INTENT_SECTION, sectionPath } from "../sections";
import { SEEK_AGES_PATH } from "./SeekAgesScreen";
import { SEEK_WHOM_PATH } from "./SeekWhomScreen";
import { useSeeking } from "./useSeeking";

export const SEEK_PATH = "/profile/seek" as const;

/**
 * The deal-breakers set; null until known, and when they could not be read:
 * the row then says nothing of them, its own screen says what failed.
 */
function useDealBreakers(): [readonly StoredDealBreaker[] | null, () => void] {
  const [stored, setStored] = useState<readonly StoredDealBreaker[] | null>(null);
  const read = useCallback(() => {
    fetchDealBreakers().then(
      ({ dealBreakers }) => setStored(dealBreakers),
      () => setStored(null),
    );
  }, []);
  return [stored, read];
}

/**
 * What a person seeks, as a list of its own (#542), built like the profile's
 * and the settings': each row its answer under onboarding's own question,
 * opening a screen of its own, and nothing edited here. Every answer is a
 * filter both ways, which the line at the top says, naming no moment: today's
 * cards stand until the next round (ADR-034 Open 5). Reached from the profile
 * alone, not Home. The list reads everything again when a screen hands back.
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

  const { seeks, ageWindow, intent } = seeking.seeking;
  const whom =
    seeks.length === GENDERS.length
      ? t("onboarding.seeks.anyone")
      : GENDERS.filter((gender) => seeks.includes(gender))
          .map((gender) => t(seeksKey(gender)))
          .join(", ");
  const ages = t("profile.seek.ages.summary", ageWindow);
  const here = intent && t(optionKey("intent", intent));
  const set =
    dealBreakers?.length === 0
      ? t("profile.seek.dealBreakers.none")
      : dealBreakers
          ?.map(({ field, paused }) => {
            const name = t(fieldLabelKey(field));
            return paused ? t("profile.seek.dealBreakers.paused", { field: name }) : name;
          })
          .join(", ");

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader
        title={t("profile.seek.title")}
        backLabel={t("profile.section.back")}
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
            {
              key: "dealBreakers",
              title: t("profile.dealBreakers.open"),
              summary: set,
              value: set,
              onPress: open(DEAL_BREAKERS_PATH),
            },
          ]}
        />
      </ScrollView>
    </SafeAreaView>
  );
}
