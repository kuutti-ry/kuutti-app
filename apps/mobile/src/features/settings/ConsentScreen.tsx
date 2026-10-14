import type { WithdrawableConsentKind } from "@kuutti/schema";
import { Text } from "@/components/ui/text";
import { ConsentSwitch, useSession } from "@/features/identity";
import { useT } from "@/lib/locale";
import { SettingsPage } from "./SettingsPage";

/** The consent named; a link to anything else is the research one. */
export const consentKindOf = (value: unknown): WithdrawableConsentKind =>
  value === "special_category" ? "special_category" : "research";

/** The title of a consent's row and screen (#287): the settings' own words, in every language. */
export const CONSENT_TITLE = {
  research: "settings.research.title",
  special_category: "settings.sensitive.title",
} as const;

/** One withdrawable consent (#46, #146) with its explanation, on a screen of its own (#287). */
export function ConsentScreen({ kind }: { kind: WithdrawableConsentKind }) {
  const { t } = useT();
  const session = useSession();
  return (
    <SettingsPage title={t(CONSENT_TITLE[kind])}>
      {session.status === "signed-in" ? (
        <ConsentSwitch kind={kind} />
      ) : (
        <Text variant="muted">{t("settings.session.none")}</Text>
      )}
    </SettingsPage>
  );
}
