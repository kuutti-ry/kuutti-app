import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useT } from "@/lib/locale";

/** One screen a settings row opens (#287): the pinned way back to the list, and the setting below it. */
export function SettingsPage({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useT();
  const router = useRouter();
  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader title={title} backLabel={t("settings.back")} onBack={() => router.back()} />
      <ScrollView contentContainerClassName="gap-6 p-6" keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}
