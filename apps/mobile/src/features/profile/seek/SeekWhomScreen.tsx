import type { Gender } from "@kuutti/schema";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { Notice } from "@/components/Notice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { ConfirmLeaveDialog } from "../ConfirmLeave";
import { useRefusedDraft, useSaveOnLeave } from "../useSaveOnLeave";
import { SeeksChips } from "./SeeksChips";
import { savedOrHeld, useSeeking } from "./useSeeking";

export const SEEK_WHOM_PATH = "/profile/seek/whom" as const;

const sameSet = (a: readonly Gender[], b: readonly Gender[]) =>
  a.length === b.length && a.every((gender) => b.includes(gender));

/**
 * Whom one seeks (#542): the seeks step's rows from the stored answer, saved
 * on leaving, as often as one wishes (ADR-060 §9). One to three, so the only
 * row chosen stays chosen and says why. The consent is not asked here: without
 * it the person never reaches this (`useSeeking`).
 */
export function SeekWhomScreen() {
  const { t } = useT();
  const router = useRouter();
  const held = useRefusedDraft<Gender[]>(SEEK_WHOM_PATH);
  const seeking = useSeeking();
  const stored = seeking.status === "ready" ? seeking.seeking.seeks : null;
  const [draft, setDraft] = useState<Gender[] | null>(held ?? null);
  // How many times the only row chosen was pressed: each is said, and a new choice ends them.
  const [refused, setRefused] = useState(0);
  const chosen = draft ?? stored;
  const leaving = useSaveOnLeave<Gender[]>({
    screen: SEEK_WHOM_PATH,
    path: SEEK_WHOM_PATH,
    held: held !== undefined,
    // With no stored answer to compare with (the read failed too), a draft is tried again.
    save: () =>
      !draft || (stored && sameSet(draft, stored)) ? null : savedOrHeld({ seeks: draft }, draft),
  });

  // A change brought back outlives a read that failed: the network that lost
  // the save usually loses the read too, and it must not vanish behind this.
  if (seeking.status === "error" && !draft) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center gap-4 p-6">
          <LoadFailed
            error={seeking.error}
            onRetry={() => void seeking.reload()}
          />
        </View>
      </SafeAreaView>
    );
  }
  if (!chosen) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center p-6">
          <Text accessibilityLiveRegion="polite">{t("load.loading")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader
        title={t("onboarding.seeks.title")}
        backLabel={t("profile.seek.back")}
        onBack={() => router.back()}
      />
      <ScrollView contentContainerClassName="flex-grow gap-6 p-6">
        <SeeksChips
          chosen={chosen}
          onChange={(next) => {
            if (next.length === 0) {
              setRefused((times) => times + 1);
              return;
            }
            setRefused(0);
            setDraft(next);
          }}
        />
        {refused > 0 && <Notice words={t("profile.seek.whom.keepOne")} answer={refused} refused />}
      </ScrollView>
      <ConfirmLeaveDialog {...leaving} reason={t("load.failed.press")} />
    </SafeAreaView>
  );
}
