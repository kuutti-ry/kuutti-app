import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useSession } from "@/features/identity";
import { useT } from "@/lib/locale";

/**
 * This device's session (#35), under its row in Settings (#511): log out
 * here, or everywhere, which is the recovery for a lost phone; a device with
 * no session says so. Errors are swallowed: the local session is cleared
 * either way, and the row expires on its own.
 */
export function DeviceActions() {
  const { t } = useT();
  const session = useSession();
  if (session.status !== "signed-in") {
    return <Text variant="muted">{t("settings.session.none")}</Text>;
  }
  return (
    <View className="flex-row flex-wrap gap-2">
      <Button
        variant="outline"
        className="grow"
        accessibilityLabel={t("settings.logout")}
        onPress={() => void session.signOut()}
      >
        <Text>{t("settings.logout")}</Text>
      </Button>
      <Button
        variant="destructive"
        className="grow"
        accessibilityLabel={t("settings.logoutAll")}
        onPress={() => void session.signOutEverywhere().catch(() => undefined)}
      >
        <Text>{t("settings.logoutAll")}</Text>
      </Button>
    </View>
  );
}
