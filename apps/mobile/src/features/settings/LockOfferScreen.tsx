import { useRouter } from "expo-router";
import { useEffect } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyboardScrollView } from "@/components/KeyboardScrollView";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { markLockOffered, useLock } from "@/features/identity";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { LockControls } from "./LockControls";

/**
 * The lock, offered once as the last of the later screens, after the e-mail
 * (#418, the maintainer's proposal): the same controls as Settings, and a
 * plain Not now that leaves it off. Shown is offered: it does not come again
 * on this phone. It keeps the passcode's field above the keyboard as the
 * e-mail's screen does (KeyboardScrollView, #103).
 */
export function LockOfferScreen() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const lock = useLock();
  useEffect(() => {
    void markLockOffered();
  }, []);
  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardScrollView contentContainerClassName="flex-grow gap-6 p-6">
        <Text variant="h1" accessibilityRole="header">
          {t("profile.later.title")}
        </Text>
        <Text variant="h2">{t("lock.offer.title")}</Text>
        <LockControls />
        <Button
          variant={lock.settings === null ? "outline" : "default"}
          onPress={() => {
            tap();
            router.replace("/");
          }}
        >
          {lock.settings === null ? t("lock.offer.notNow") : t("lock.offer.done")}
        </Button>
      </KeyboardScrollView>
    </SafeAreaView>
  );
}
