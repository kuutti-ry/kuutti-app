import { Text } from "@/components/ui/text";
import { useSession } from "@/features/identity";
import { Invitations } from "@/features/rewards";
import { useT } from "@/lib/locale";
import { SettingsPage } from "./SettingsPage";

/** Invitations for friends and a code from one (#107, ADR-044); signed out, the screen says so. */
export function InvitationsSettingsScreen() {
  const { t } = useT();
  const session = useSession();
  return (
    <SettingsPage title={t("settings.invite.label")}>
      {session.status === "signed-in" ? (
        <Invitations />
      ) : (
        <Text variant="muted">{t("settings.session.none")}</Text>
      )}
    </SettingsPage>
  );
}
