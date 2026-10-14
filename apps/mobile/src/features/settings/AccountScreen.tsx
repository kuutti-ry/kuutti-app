import { AccountActions } from "@/features/identity";
import { useT } from "@/lib/locale";
import { SettingsPage } from "./SettingsPage";

/** The export, the break and the deletion (#51, #170), the deletion last. */
export function AccountScreen() {
  const { t } = useT();
  return (
    <SettingsPage title={t("account.title")}>
      <AccountActions />
    </SettingsPage>
  );
}
