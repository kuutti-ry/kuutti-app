import { Text } from "@/components/ui/text";
import { EmailCard, useSession } from "@/features/identity";
import { useT } from "@/lib/locale";
import { SettingsPage } from "./SettingsPage";

/** The optional e-mail (#148): a way to stay in touch (#385), never shown, never a login; signed out, the screen says so. */
export function EmailSettingsScreen() {
  const { t } = useT();
  const session = useSession();
  return (
    <SettingsPage title={t("settings.email.label")}>
      {session.status === "signed-in" ? (
        <EmailCard />
      ) : (
        <Text variant="muted">{t("settings.session.none")}</Text>
      )}
    </SettingsPage>
  );
}
