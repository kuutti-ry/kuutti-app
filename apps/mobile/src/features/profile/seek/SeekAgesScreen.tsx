import { AGE_MAX, AGE_MIN, type AgeWindow } from "@kuutti/schema";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Stepper } from "@/components/ui/stepper";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { ConfirmLeaveDialog } from "../ConfirmLeave";
import { useRefusedDraft, useSaveOnLeave } from "../useSaveOnLeave";
import { savedOrHeld, useSeeking } from "./useSeeking";

export const SEEK_AGES_PATH = "/profile/seek/ages" as const;

/**
 * The age window (#542): the bounds of onboarding, from the stored answer,
 * saved on leaving. Two steppers stacked, since side by side they overflow at
 * 320 pt, and no slider: a slider's thumb is the accessibility failure Tinder's
 * is reported for, and every answer is a button (ADR-010 §9).
 */
export function SeekAgesScreen() {
  const { t } = useT();
  const router = useRouter();
  const held = useRefusedDraft<AgeWindow>(SEEK_AGES_PATH);
  const seeking = useSeeking();
  const stored = seeking.status === "ready" ? seeking.seeking.ageWindow : null;
  const [draft, setDraft] = useState<AgeWindow | null>(held ?? null);
  const ages = draft ?? stored;
  const leaving = useSaveOnLeave<AgeWindow>({
    screen: SEEK_AGES_PATH,
    path: SEEK_AGES_PATH,
    held: held !== undefined,
    // With no stored answer to compare with (the read failed too), a draft is tried again.
    save: () =>
      !draft || (stored && draft.min === stored.min && draft.max === stored.max)
        ? null
        : savedOrHeld({ ageWindow: draft }, draft),
  });

  // A change brought back outlives a read that failed: see SeekWhomScreen.
  if (seeking.status === "error" && !draft) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center gap-4 p-6">
          <LoadFailed
            headline={t("profile.failed")}
            error={seeking.error}
            onRetry={() => void seeking.reload()}
          />
        </View>
      </SafeAreaView>
    );
  }
  if (!ages) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center p-6">
          <Text accessibilityLiveRegion="polite">{t("profile.loading")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader
        title={t("onboarding.age.title")}
        backLabel={t("profile.seek.back")}
        onBack={() => router.back()}
      />
      <ScrollView contentContainerClassName="flex-grow gap-6 p-6">
        <Text>{t("profile.seek.ages.explain", { min: AGE_MIN, max: AGE_MAX })}</Text>
        <Stepper
          label={t("onboarding.age.youngest")}
          value={ages.min}
          shown={t("onboarding.age.years", { years: ages.min })}
          downLabel={t("onboarding.age.youngestDown")}
          upLabel={t("onboarding.age.youngestUp")}
          canDown={ages.min > AGE_MIN}
          canUp={ages.min < ages.max}
          onChange={(min) => setDraft({ ...ages, min })}
        />
        <Stepper
          label={t("onboarding.age.oldest")}
          value={ages.max}
          shown={t("onboarding.age.years", { years: ages.max })}
          downLabel={t("onboarding.age.oldestDown")}
          upLabel={t("onboarding.age.oldestUp")}
          canDown={ages.max > ages.min}
          canUp={ages.max < AGE_MAX}
          onChange={(max) => setDraft({ ...ages, max })}
        />
      </ScrollView>
      <ConfirmLeaveDialog {...leaving} reason={t("profile.seek.failed")} />
    </SafeAreaView>
  );
}
