import type { AgeWindow } from "@kuutti/schema";
import { useState } from "react";
import { ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailedScreen, LoadingScreen } from "@/components/LoadFailed";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useT } from "@/lib/locale";
import { ConfirmLeaveDialog } from "../ConfirmLeave";
import { useRefusedDraft, useSaveOnLeave } from "../useSaveOnLeave";
import { AgeWindowSteppers } from "./AgeWindowSteppers";
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
    return <LoadFailedScreen error={seeking.error} onRetry={() => void seeking.reload()} />;
  }
  if (!ages) {
    return <LoadingScreen />;
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader title={t("onboarding.age.title")} backLabel={t("profile.seek.back")} />
      <ScrollView contentContainerClassName="flex-grow gap-6 p-6">
        <AgeWindowSteppers ages={ages} onChange={setDraft} />
      </ScrollView>
      <ConfirmLeaveDialog {...leaving} reason={t("load.failed.press")} />
    </SafeAreaView>
  );
}
