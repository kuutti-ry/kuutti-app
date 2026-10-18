import { Text } from "@/components/ui/text";
import { YourContacts } from "@/features/chat";
import { useSession } from "@/features/identity";
import { useT } from "@/lib/locale";
import { SettingsPage } from "./SettingsPage";

/** The contacts a person keeps to share in a conversation (#103); signed out, the screen says so. */
export function ContactsSettingsScreen() {
  const { t } = useT();
  const session = useSession();
  return (
    <SettingsPage title={t("settings.contacts.label")}>
      {session.status === "signed-in" ? (
        <YourContacts />
      ) : (
        <Text variant="muted">{t("settings.session.none")}</Text>
      )}
    </SettingsPage>
  );
}
