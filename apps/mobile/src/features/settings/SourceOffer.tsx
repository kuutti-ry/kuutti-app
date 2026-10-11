import ExternalLink from "lucide-react-native/icons/external-link";
import { Linking, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";

/**
 * The source-code offer of AGPL-3.0 section 13 (#16): the address the running
 * service names in /health. The commits of the API and of the app stand in
 * the cards above it. It is shown to every user, in every build, so it sits
 * on the screen and not in the dev settings sheet; it moves to the About
 * screen when product screens arrive (M3). The address is text as well as a
 * link, so the offer stands where no browser opens. The contract only admits
 * https URLs.
 */
export function SourceOffer({ source }: { source: string }) {
  const { t } = useT();
  return (
    <View className="w-full max-w-md items-center gap-2">
      <Text variant="small" accessibilityRole="header">
        {t("about.source.title")}
      </Text>
      <Text variant="muted" className="text-center">
        {t("about.source.body")}
      </Text>
      <Button
        variant="ghost"
        accessibilityRole="link"
        accessibilityLabel={t("about.source.open")}
        onPress={() => void Linking.openURL(source)}
      >
        <Text className="shrink text-primary underline">{source}</Text>
        <Icon as={ExternalLink} className="text-primary" size={16} />
      </Button>
    </View>
  );
}
