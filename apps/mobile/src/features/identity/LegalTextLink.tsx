import { CONSENT_VERSIONS, type LegalTextKind, legalPageUrl } from "@kuutti/i18n";
import ExternalLink from "lucide-react-native/icons/external-link";
import { Linking } from "react-native";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";

/**
 * The line under a legal summary (#208, ADR-010 §4): the version this app
 * carries, as a link to the full text on the website at the anchor of that
 * version. The summary is what the person accepts here; the site's Finnish
 * text binds, under the same version, and CI holds the two to one version
 * (`pnpm check:legal-versions`). The browser opens the public site, never a
 * page of the product (rule 8), as the source-code offer does.
 */
export function LegalTextLink({ kind }: { kind: LegalTextKind }) {
  const { t } = useT();
  const version = CONSENT_VERSIONS[kind] ?? "";
  const label = t("onboarding.consents.fullText", { version });
  return (
    <Button
      variant="ghost"
      accessibilityRole="link"
      accessibilityLabel={label}
      className="self-start px-0"
      onPress={() => void Linking.openURL(legalPageUrl(kind, version))}
    >
      <Text className="shrink text-primary underline">{label}</Text>
      <Icon as={ExternalLink} className="text-primary" size={16} />
    </Button>
  );
}
