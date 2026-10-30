import { useState } from "react";
import { View } from "react-native";
import { Notice } from "@/components/Notice";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Text } from "@/components/ui/text";
import { useSession } from "@/features/identity";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";

/**
 * Logging out (#35), under its row in Settings (#511): here, or everywhere,
 * which is the recovery for a lost phone, each with what it does under it,
 * both outlined (red is the deletion's alone). Everywhere asks first, since
 * every phone then needs the bank again (the maintainer, 29/10/2026); here
 * asks nothing. A device with no session says so. A logout here clears the
 * session whatever the API answers; everywhere that the API did not take is
 * said, and this phone stays logged in.
 */
export function DeviceActions() {
  const { t } = useT();
  const tap = useHapticTap();
  const session = useSession();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(0);
  if (session.status !== "signed-in") {
    return <Text variant="muted">{t("settings.session.none")}</Text>;
  }
  // One request at a time; a retry hides the last failure until it is answered.
  const everywhere = async () => {
    setAsking(false);
    setBusy(true);
    try {
      await session.signOutEverywhere();
    } catch {
      setFailed((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-4">
      <View className="gap-1.5">
        <Button
          variant="outline"
          accessibilityLabel={t("settings.logout")}
          disabled={busy}
          onPress={() => {
            tap();
            void session.signOut();
          }}
        >
          <Text>{t("settings.logout")}</Text>
        </Button>
        <Text variant="muted">{t("settings.logout.explain")}</Text>
      </View>
      <View className="gap-1.5">
        <Button
          variant="outline"
          accessibilityLabel={t("settings.logoutAll")}
          disabled={busy}
          onPress={() => {
            tap();
            setAsking(true);
          }}
        >
          <Text>{t("settings.logoutAll")}</Text>
        </Button>
        <Text variant="muted">{t("settings.logoutAll.explain")}</Text>
        {!busy && failed > 0 && (
          <Notice refused words={t("settings.logoutAll.failed")} answer={failed} />
        )}
      </View>
      <Dialog open={asking} onOpenChange={(open) => !open && setAsking(false)}>
        <DialogContent closeLabel={t("settings.logoutAll.confirm.close")}>
          <DialogHeader>
            <DialogTitle>{t("settings.logoutAll.confirm.title")}</DialogTitle>
            <DialogDescription>{t("settings.logoutAll.confirm.body")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onPress={() => setAsking(false)}>
              {t("settings.logoutAll.confirm.no")}
            </Button>
            <Button variant="outline" onPress={() => void everywhere()}>
              {t("settings.logoutAll.confirm.yes")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  );
}
