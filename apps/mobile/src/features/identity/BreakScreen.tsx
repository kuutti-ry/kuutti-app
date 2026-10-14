import { useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { useSession } from "./session";

const CONSEQUENCES = [
  "account.break.hidden",
  "account.break.signedOut",
  "account.break.comesBack",
] as const;

/**
 * Taking a break (#170, ADR-022), after S-mobiili's "Stop using" screen:
 * three lines of consequences, a switch that says "I understand", and a
 * button that waits for it. The API pauses the account and ends every
 * session; the provider signs the device out with a notice, and the sign-in
 * screen says why it is back. Nothing is deleted: the erasure of #51 is
 * another button, behind its own question.
 */
export function BreakScreen() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const session = useSession();
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const start = async () => {
    tap();
    setFailed(false);
    setBusy(true);
    try {
      await session.pauseAccount();
      // The provider is signed out now; SignedOutToStart takes the app to the sign-in.
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader
        title={t("account.break.title")}
        backLabel={t("account.break.back")}
        onBack={() => router.back()}
      />
      <ScrollView contentContainerClassName="gap-6 p-6">
        <Text>{t("account.break.intro")}</Text>
        <View className="gap-3" accessibilityRole="list">
          {CONSEQUENCES.map((key) => (
            <Text key={key} accessibilityRole="text">
              {t(key)}
            </Text>
          ))}
        </View>

        {/* The tick is the person's word; the button below waits for it. The
            label toggles the switch too, so the words are a target as well. */}
        <View className="flex-row items-center justify-between gap-4">
          <Label
            nativeID="break-understand-label"
            onPress={() => !busy && setUnderstood(!understood)}
          >
            {t("account.break.understand")}
          </Label>
          <Switch
            accessibilityLabel={t("account.break.understand")}
            checked={understood}
            disabled={busy}
            onCheckedChange={setUnderstood}
          />
        </View>

        {failed && <Text accessibilityLiveRegion="assertive">{t("account.break.failed")}</Text>}
        {busy && <Text accessibilityLiveRegion="polite">{t("account.break.working")}</Text>}

        <Button
          accessibilityLabel={t("account.break.confirm")}
          disabled={!understood || busy}
          onPress={() => void start()}
        >
          <Text>{t("account.break.confirm")}</Text>
        </Button>
      </ScrollView>
    </SafeAreaView>
  );
}
