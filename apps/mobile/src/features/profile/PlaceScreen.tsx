import type { PlainMessageKey } from "@kuutti/i18n";
import type { HomeSummary, HomeUpdate } from "@kuutti/schema";
import { useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyboardScrollView } from "@/components/KeyboardScrollView";
import { LoadFailed } from "@/components/LoadFailed";
import { sayAloud } from "@/components/Notice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Text } from "@/components/ui/text";
import { ApiError } from "@/lib/api";
import { useT } from "@/lib/locale";
import { saveHome } from "./client";
import { PlaceChoice, PlacePicker, useSpokenOnIos } from "./PlaceEditor";
import { useProfile } from "./useProfile";

type Notice = "unknown" | "failed";

const NOTICE: Readonly<Record<Notice, PlainMessageKey>> = {
  unknown: "errors.postal_code_unknown",
  failed: "load.failed.press",
};

/**
 * The person's home after onboarding (ADR-061): what their card shows of it,
 * and a new postal code, as often as they like (§1), which starts the card
 * from the town again (§3). In words only: a place's digits are never shown
 * back, and what was typed goes with the save. Both save on the tap, so
 * nothing waits to be lost on leaving. A save is heard, not drawn (#581): the
 * filled button moves, or the field empties and the buttons show the new town.
 */
export function PlaceScreen() {
  const { t } = useT();
  const router = useRouter();
  const profile = useProfile();
  // The API's answer to the last save, which the profile's read is older than.
  const [saved, setSaved] = useState<HomeSummary | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [picks, setPicks] = useState(0);
  const words = notice === null ? null : t(NOTICE[notice]);
  useSpokenOnIos(words);

  if (profile.status === "loading") {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center p-6">
          <Text accessibilityLiveRegion="polite">{t("load.loading")}</Text>
        </View>
      </SafeAreaView>
    );
  }
  if (profile.status === "error") {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center gap-4 p-6">
          <LoadFailed error={profile.error} onRetry={() => void profile.reload()} />
        </View>
      </SafeAreaView>
    );
  }

  const save = async (update: HomeUpdate) => {
    setSaving(true);
    setNotice(null);
    sayAloud(t("profile.saving"));
    try {
      setSaved(await saveHome(update));
      sayAloud(t("profile.place.saved"));
      // A new key clears the field: the digits go with their save.
      if (update.postalCode !== undefined) setPicks((n) => n + 1);
    } catch (error) {
      const unknown = error instanceof ApiError && error.code === "postal_code_unknown";
      setNotice(unknown ? "unknown" : "failed");
    } finally {
      setSaving(false);
    }
  };
  const home = saved ?? profile.home;

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader
        title={t("profile.place.title")}
        backLabel={t("profile.place.back")}
        onBack={() => router.back()}
      />
      <KeyboardScrollView contentContainerClassName="flex-grow gap-6 p-6">
        <Text>{t("profile.place.othersSee")}</Text>
        {home && (
          <PlaceChoice home={home} busy={saving} onChoose={(showArea) => void save({ showArea })} />
        )}
        {words !== null && <Text accessibilityLiveRegion="assertive">{words}</Text>}
        <PlacePicker
          key={picks}
          busy={saving}
          refused={notice === "unknown"}
          onPick={(postalCode) => void save({ postalCode })}
        />
      </KeyboardScrollView>
    </SafeAreaView>
  );
}
