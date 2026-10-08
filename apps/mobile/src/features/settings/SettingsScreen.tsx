import { LOCALE_NAMES, type PlainMessageKey } from "@kuutti/i18n";
import { useRouter } from "expo-router";
import ArrowLeft from "lucide-react-native/icons/arrow-left";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { AccountActions, EmailCard, useSession } from "@/features/identity";
import { fetchHealth } from "@/lib/api";
import {
  LOCALE_FLAGS,
  type LocalePreference,
  OFFERED_LOCALES,
  useLocaleSettings,
  useT,
} from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { type SchemePreference, useTheme } from "@/theme/ThemeProvider";
import { SourceOffer } from "./SourceOffer";

const SCHEMES: ReadonlyArray<{ value: SchemePreference; label: PlainMessageKey }> = [
  { value: "system", label: "settings.theme.system" },
  { value: "light", label: "settings.theme.light" },
  { value: "dark", label: "settings.theme.dark" },
];

/**
 * One option of a group. The chosen one is marked in text too, never by colour
 * alone. A flag, when given, is decoration in front of the text: the accessible
 * name is the text alone, so a screen reader never announces "flag: Åland".
 */
function Choice(props: { label: string; flag?: string; chosen: boolean; onPress: () => void }) {
  const { t } = useT();
  const name = props.chosen ? t("settings.selected", { option: props.label }) : props.label;
  return (
    <Button
      variant={props.chosen ? "default" : "outline"}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.chosen }}
      // react-native-web reads the ARIA prop, not accessibilityState.
      aria-checked={props.chosen}
      accessibilityLabel={name}
      className="grow"
      onPress={props.onPress}
    >
      {props.flag ? `${props.flag} ${name}` : name}
    </Button>
  );
}

/**
 * The person's own settings, after login, in every build (#143; the team's
 * notes of 08/10): theme and high contrast (the OS's by default, kept across
 * restarts), the language (the phone's by default), this device's session,
 * the account (export, deletion, the research opt-in; #51) and the source
 * offer of AGPL-3.0 section 13, which stays visible to everybody. What is
 * technical (commits, the API, a test error) is the tech config screen and
 * exists outside production only.
 */
export function SettingsScreen() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const theme = useTheme();
  const locale = useLocaleSettings();
  const session = useSession();
  // The address of the running service's source, as /health names it (AGPL §13).
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchHealth()
      .then((health) => live && setSource(health.source))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const languages: ReadonlyArray<{ value: LocalePreference; label: string; flag?: string }> = [
    { value: "system", label: t("settings.language.system") },
    // A language is listed under its own name, whatever the app's language is.
    ...OFFERED_LOCALES.map((value) => ({
      value,
      label: LOCALE_NAMES[value],
      flag: LOCALE_FLAGS[value],
    })),
  ];

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="gap-6 p-6">
        <View className="flex-row items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            accessibilityLabel={t("settings.back")}
            onPress={() => {
              tap();
              router.back();
            }}
          >
            <Icon as={ArrowLeft} />
          </Button>
          <Text variant="h1" accessibilityRole="header">
            {t("settings.title")}
          </Text>
        </View>

        <View className="gap-2">
          <Text variant="small" accessibilityRole="header">
            {t("settings.theme.label")}
          </Text>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={t("settings.theme.label")}
            className="flex-row flex-wrap gap-2"
          >
            {SCHEMES.map(({ value, label }) => (
              <Choice
                key={value}
                label={t(label)}
                chosen={theme.preference === value}
                onPress={() => theme.setPreference(value)}
              />
            ))}
          </View>
        </View>

        <View className="flex-row items-center justify-between gap-4">
          <Label
            nativeID="high-contrast-label"
            onPress={() => theme.setHighContrast(!theme.highContrast)}
          >
            {t("settings.highContrast")}
          </Label>
          <Switch
            accessibilityLabel={t("settings.highContrast")}
            checked={theme.highContrast}
            onCheckedChange={theme.setHighContrast}
          />
        </View>

        <View className="gap-2">
          <Text variant="small" accessibilityRole="header">
            {t("settings.language.label")}
          </Text>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={t("settings.language.label")}
            className="flex-row flex-wrap gap-2"
          >
            {languages.map(({ value, label, flag }) => (
              <Choice
                key={value}
                label={label}
                flag={flag}
                chosen={locale.preference === value}
                onPress={() => locale.setPreference(value)}
              />
            ))}
          </View>
        </View>

        {/* This device's session (#35): log out here, or everywhere, which is
            the recovery for a lost phone. Errors are swallowed: the local
            session is cleared either way, and the row expires on its own. */}
        <View className="gap-2">
          <Text variant="small" accessibilityRole="header">
            {t("settings.session.label")}
          </Text>
          {session.status === "signed-in" ? (
            <View className="flex-row flex-wrap gap-2">
              <Button
                variant="outline"
                className="grow"
                accessibilityLabel={t("settings.logout")}
                onPress={() => void session.signOut()}
              >
                <Text>{t("settings.logout")}</Text>
              </Button>
              <Button
                variant="destructive"
                className="grow"
                accessibilityLabel={t("settings.logoutAll")}
                onPress={() => void session.signOutEverywhere().catch(() => undefined)}
              >
                <Text>{t("settings.logoutAll")}</Text>
              </Button>
            </View>
          ) : (
            <Text variant="muted">{t("settings.session.none")}</Text>
          )}
        </View>

        {/* Export, the research opt-in and deletion (#51): nothing when signed out. */}
        <AccountActions />
        {/* The optional e-mail (#148): a way back in, never shown, never a login. */}
        <EmailCard />

        <View className="gap-2">
          <Text variant="small" accessibilityRole="header">
            {t("settings.about.title")}
          </Text>
          {source ? (
            <SourceOffer source={source} />
          ) : (
            <Text variant="muted">{t("about.source.body")}</Text>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
