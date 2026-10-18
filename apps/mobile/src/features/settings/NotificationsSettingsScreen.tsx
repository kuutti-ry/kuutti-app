import { Text } from "@/components/ui/text";
import { useSession } from "@/features/identity";
import { NotificationChoices } from "@/features/notifications";
import { useT } from "@/lib/locale";
import { SettingsPage } from "./SettingsPage";

/** What the person may be notified of (#176); signed out, the screen says so. */
export function NotificationsSettingsScreen() {
  const { t } = useT();
  const session = useSession();
  return (
    <SettingsPage title={t("settings.notifications.label")}>
      {session.status === "signed-in" ? (
        <NotificationChoices />
      ) : (
        <Text variant="muted">{t("settings.session.none")}</Text>
      )}
    </SettingsPage>
  );
}
