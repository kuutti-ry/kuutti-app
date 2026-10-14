import type { WithdrawableConsentKind } from "@kuutti/schema";
import { Text } from "@/components/ui/text";
import { ConsentSwitches, useSession } from "@/features/identity";
import { useT } from "@/lib/locale";
import { SettingsPage } from "./SettingsPage";

/** The consent named; a link to anything else is the research one. */
export const consentKindOf = (value: unknown): WithdrawableConsentKind =>
  value === "special_category" ? "special_category" : "research";

/** One withdrawable consent (#46, #146) with its explanation, on a screen of its own (#287). */
export function ConsentScreen({ kind }: { kind: WithdrawableConsentKind }) {
  const { t } = useT();
  const session = useSession();
  return (
    <SettingsPage
      title={t(kind === "research" ? "legal.research.title" : "legal.special_category.title")}
    >
      {session.status === "signed-in" ? (
        <ConsentSwitches only={kind} />
      ) : (
        <Text variant="muted">{t("settings.session.none")}</Text>
      )}
    </SettingsPage>
  );
}
