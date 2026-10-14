import { EmailCard } from "@/features/identity";
import { useT } from "@/lib/locale";
import { SettingsPage } from "./SettingsPage";

/** The optional e-mail (#148): a way back in, never shown, never a login. */
export function EmailSettingsScreen() {
  const { t } = useT();
  return (
    <SettingsPage title={t("settings.email.label")}>
      <EmailCard />
    </SettingsPage>
  );
}
