import { Text } from "@/components/ui/text";
import { AccountActions, useSession } from "@/features/identity";
import { useT } from "@/lib/locale";
import { SettingsPage } from "./SettingsPage";

/** The export, the break and the deletion (#51, #170), the deletion last; signed out, the screen says so. */
export function AccountScreen() {
  const { t } = useT();
  const session = useSession();
  return (
    <SettingsPage title={t("account.title")}>
      {session.status === "signed-in" ? (
        <AccountActions />
      ) : (
        <Text variant="muted">{t("settings.session.none")}</Text>
      )}
    </SettingsPage>
  );
}
