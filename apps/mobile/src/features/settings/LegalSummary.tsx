import { Text } from "@/components/ui/text";
import { LegalTextLink } from "@/features/identity";
import { useT } from "@/lib/locale";

export type LegalKind = "terms" | "privacy";

/**
 * The terms of use or the privacy policy, as the app carries them, under
 * their row in Settings (#287, #511): the summary onboarding showed, and the
 * version it carries as a link to the full text on the website (#208), as a
 * consent's row has its own; nothing here is machine-translated
 * (rules/i18n.md).
 */
export function LegalSummary({ kind }: { kind: LegalKind }) {
  const { t } = useT();
  return (
    <>
      <Text>{t(kind === "terms" ? "legal.terms.summary" : "legal.privacy.summary")}</Text>
      <LegalTextLink kind={kind} />
    </>
  );
}
