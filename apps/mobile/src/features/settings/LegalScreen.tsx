import { CONSENT_VERSIONS } from "@kuutti/i18n";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { SettingsPage } from "./SettingsPage";

export type LegalKind = "terms" | "privacy";

/** The text read as its version; a link to anything else is "terms". */
export const legalKindOf = (value: unknown): LegalKind =>
  value === "privacy" ? "privacy" : "terms";

/**
 * The terms of use or the privacy policy, as the app carries them (#287): the
 * summary onboarding showed, and the version it carries. The full texts are
 * #208's; nothing here is machine-translated (rules/i18n.md).
 */
export function LegalScreen({ kind }: { kind: LegalKind }) {
  const { t } = useT();
  return (
    <SettingsPage title={t(kind === "terms" ? "legal.terms.title" : "legal.privacy.title")}>
      <Text>{t(kind === "terms" ? "legal.terms.summary" : "legal.privacy.summary")}</Text>
      <Text variant="muted">
        {t("onboarding.consents.version", { version: CONSENT_VERSIONS[kind] ?? "" })}
      </Text>
    </SettingsPage>
  );
}
