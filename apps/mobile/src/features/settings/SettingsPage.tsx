import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { KeyboardAvoidingView, Platform, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useT } from "@/lib/locale";

/**
 * One screen a settings row opens (#287): the pinned way back to the list, and
 * the setting below it. A field low on the page stays in sight above the
 * keyboard (#103, the contacts' last card): iOS insets the scroll view and
 * scrolls the field up itself. Android draws the app edge to edge, so the
 * window no longer resizes for the keyboard (as in the conversation's
 * composer): the padding ends the scroll view at the keyboard's top, and
 * Android's scroll view then scrolls the focused field into view as it
 * shrinks. Padding on iOS too would take the keyboard's height twice.
 */
export function SettingsPage({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useT();
  const router = useRouter();
  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader title={title} backLabel={t("settings.back")} onBack={() => router.back()} />
      <KeyboardAvoidingView
        className="flex-1"
        behavior="padding"
        enabled={Platform.OS === "android"}
      >
        <ScrollView
          contentContainerClassName="gap-6 p-6"
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
