import { Image } from "expo-image";
import ExternalLink from "lucide-react-native/icons/external-link";
import Phone from "lucide-react-native/icons/phone";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { DECORATIVE } from "@/theme/a11y";
import { SettingsPage } from "./SettingsPage";
import {
  EMERGENCY_NUMBER,
  numbersOf,
  openQuietly,
  SUPPORT_LINES,
  type SupportLine,
  siteOf,
  telOf,
} from "./support-lines";

const FILL = { width: "100%", height: "100%" } as const;

/**
 * One service as a tile: its logo on a plate that stays light in every theme,
 * since the logos are made for a light page; its name, what it is for and its
 * hours in words, so the logo is decoration; the number and the site.
 */
function Tile({ line }: { line: SupportLine }) {
  const { t, locale } = useT();
  const name = t(line.name);
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <View className="h-24 border-b border-border bg-logo-plate p-3">
        <Image
          testID="support-logo"
          source={line.logo}
          contentFit="contain"
          style={FILL}
          {...DECORATIVE}
        />
      </View>
      <View className="gap-2 p-3">
        <Text variant="title" role="heading" aria-level="2">
          {name}
        </Text>
        <Text>{t(line.about)}</Text>
        <Text variant="muted">{t(line.hours)}</Text>
        <View className="gap-1 pt-1">
          {numbersOf(line, locale).map(({ number, language }) => (
            <View key={number} className="gap-1">
              {language && <Text variant="muted">{t(language)}</Text>}
              <Button
                variant="outline"
                className="px-2"
                accessibilityLabel={t("support.call", { name, number })}
                onPress={() => void openQuietly(telOf(number))}
              >
                <Icon as={Phone} size={16} />
                <Text>{number}</Text>
              </Button>
            </View>
          ))}
          <Button
            variant="ghost"
            className="px-2"
            accessibilityRole="link"
            accessibilityLabel={t("support.site.label", { name })}
            onPress={() => void openQuietly(siteOf(line, locale))}
          >
            <Text className="shrink text-primary underline">{t("support.site")}</Text>
            <Icon as={ExternalLink} className="text-primary" size={16} />
          </Button>
        </View>
      </View>
    </Card>
  );
}

/**
 * Where to turn when it is hard (#510): mental and emotional support, not
 * help with the app. Four services one under another, since side by side they
 * were squeezed (the maintainer, 04/11/2026), and 112 above them for danger. The
 * page is static: it asks nothing of the API and needs no session, and no crash
 * report names it (lib/sentry.ts), since who opens it is nobody's business.
 */
export function SupportScreen() {
  const { t } = useT();
  return (
    <SettingsPage title={t("settings.support.label")}>
      <Text>{t("support.intro")}</Text>
      <Button
        variant="outline"
        accessibilityLabel={t("support.emergency")}
        onPress={() => void openQuietly(telOf(EMERGENCY_NUMBER))}
      >
        <Icon as={Phone} size={16} />
        <Text className="shrink">{t("support.emergency")}</Text>
      </Button>
      <View testID="support-list" className="gap-3">
        {SUPPORT_LINES.map((line) => (
          <Tile key={line.id} line={line} />
        ))}
      </View>
      <Text variant="muted">{t("support.independent")}</Text>
    </SettingsPage>
  );
}
