import { Text } from "@/components/ui/text";
import { useSession } from "@/features/identity";
import { useT } from "@/lib/locale";
import { LockControls } from "./LockControls";
import { SettingsPage } from "./SettingsPage";

/** The app's lock on this phone (#418): off until the person turns it on here or in its one offer. */
export function LockSettingsScreen() {
  const { t } = useT();
  const session = useSession();
  return (
    <SettingsPage title={t("settings.lock.label")}>
      {session.status === "signed-in" ? (
        <LockControls />
      ) : (
        <Text variant="muted">{t("settings.session.none")}</Text>
      )}
    </SettingsPage>
  );
}
