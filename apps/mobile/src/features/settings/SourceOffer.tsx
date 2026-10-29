import ExternalLink from "lucide-react-native/icons/external-link";
import { Linking, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";

/**
 * The source-code offer of AGPL-3.0 section 13 (#16): the address the running
 * service names in /health. Shown to every user, in every build, under its
 * row in "About Kuutti" in Settings, beside the version and the build (#287,
 * #511), and on the tech config screen beside the API's commit. Set to the
 * left, as the legal texts' links are. The address
 * is text as well as a link, so the offer stands where no browser opens. The
 * contract only admits https URLs. Each screen carries the heading.
 *
 * The link is named by the address, as the legal-text link is by its words: a
 * screen reader hears the offer itself, and voice control finds it by what it
 * shows. Where it leads is the hint (#217).
 */
export function SourceOffer({ source }: { source: string }) {
  const { t } = useT();
  return (
    <View className="w-full max-w-md gap-2">
      <Text>{t("about.source.body")}</Text>
      <Button
        variant="ghost"
        className="self-start px-0"
        accessibilityRole="link"
        accessibilityLabel={source}
        accessibilityHint={t("about.source.open")}
        onPress={() => void Linking.openURL(source)}
      >
        <Text className="shrink text-primary underline">{source}</Text>
        <Icon as={ExternalLink} className="text-primary" size={16} />
      </Button>
    </View>
  );
}
