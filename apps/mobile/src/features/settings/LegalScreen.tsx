import { Text } from "@/components/ui/text";
import { LegalTextLink } from "@/features/identity";
import { useT } from "@/lib/locale";
import { SettingsPage } from "./SettingsPage";

export type LegalKind = "terms" | "privacy";

/** The text read as its version; a link to anything else is "terms". */
export const legalKindOf = (value: unknown): LegalKind =>
  value === "privacy" ? "privacy" : "terms";

/**
 * The terms of use or the privacy policy, as the app carries them (#287): the
 * summary onboarding showed, and the version it carries as a link to the full
 * text on the website (#208); nothing here is machine-translated (rules/i18n.md).
 */
export function LegalScreen({ kind }: { kind: LegalKind }) {
  const { t } = useT();
  return (
    <SettingsPage title={t(kind === "terms" ? "legal.terms.title" : "legal.privacy.title")}>
      <Text>{t(kind === "terms" ? "legal.terms.summary" : "legal.privacy.summary")}</Text>
      <LegalTextLink kind={kind} />
    </SettingsPage>
  );
}
