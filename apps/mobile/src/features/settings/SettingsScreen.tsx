import { CONSENT_VERSIONS, LOCALE_NAMES } from "@kuutti/i18n";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { type Row, RowGroup } from "@/components/RowGroup";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Text } from "@/components/ui/text";
import { useSession } from "@/features/identity";
import LICENSES from "@/generated/licenses.json";
import { useLocaleSettings, useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { useTheme } from "@/theme/ThemeProvider";
import { SCHEMES } from "./Choice";

/** A heading and its rows. */
function Section({ title, rows }: { title: string; rows: readonly Row[] }) {
  return (
    <View className="gap-2">
      <Text variant="h3" accessibilityRole="header">
        {title}
      </Text>
      <RowGroup rows={rows} />
    </View>
  );
}

/**
 * The person's own settings, after login, in every build (#143): a list of
 * sections the way the profile's front page is one (#227, #287), each row a
 * screen of its own. Appearance and language (the OS's and the phone's by
 * default, kept across restarts); the legal part, the two consents (#46,
 * #146) and the texts they refer to; about Kuutti, the version, the source
 * offer of AGPL-3.0 section 13 (visible to everybody) and the licences; the
 * account, this device, the e-mail, and the export, the break and the
 * deletion last (#51, #148, #170). What is technical (commits, the API, a
 * test error) is the tech config screen and exists outside production only.
 */
export function SettingsScreen() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const theme = useTheme();
  const locale = useLocaleSettings();
  const session = useSession();
  const open = (path: Parameters<typeof router.push>[0]) => () => {
    tap();
    router.push(path);
  };

  const themeName = t(
    SCHEMES.find((s) => s.value === theme.preference)?.label ?? "settings.theme.system",
  );
  const themeSummary = theme.highContrast
    ? t("settings.theme.withContrast", { theme: themeName })
    : themeName;
  const languageSummary =
    locale.preference === "system"
      ? t("settings.language.system")
      : LOCALE_NAMES[locale.preference];
  // The counted version (#172) rides in extra, which the fingerprint skips; app.json's is the store's.
  const version: unknown = Constants.expoConfig?.extra?.version ?? Constants.expoConfig?.version;
  const commit: unknown = Constants.expoConfig?.extra?.commit;
  const signedIn = session.status === "signed-in";

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScreenHeader
        title={t("settings.title")}
        backLabel={t("settings.back")}
        onBack={() => router.back()}
      />
      <ScrollView contentContainerClassName="gap-6 p-6">
        <Section
          title={t("settings.section.appearance")}
          rows={[
            {
              key: "theme",
              title: t("settings.theme.label"),
              summary: themeSummary,
              onPress: open("/settings/theme"),
            },
            {
              key: "language",
              title: t("settings.language.label"),
              summary: languageSummary,
              onPress: open("/settings/language"),
            },
          ]}
        />
        <Section
          title={t("settings.section.agreements")}
          rows={[
            // The two withdrawable consents: a choice about the app, so with its settings; nothing signed out.
            ...(signedIn
              ? [
                  {
                    key: "research",
                    title: t("account.research.label"),
                    onPress: open("/settings/consent/research"),
                  },
                  {
                    key: "special_category",
                    title: t("account.specialCategory.label"),
                    onPress: open("/settings/consent/special_category"),
                  },
                ]
              : []),
            {
              key: "terms",
              title: t("legal.terms.title"),
              summary: t("onboarding.consents.version", { version: CONSENT_VERSIONS.terms ?? "" }),
              onPress: open("/settings/legal/terms"),
            },
            {
              key: "privacy",
              title: t("legal.privacy.title"),
              summary: t("onboarding.consents.version", {
                version: CONSENT_VERSIONS.privacy ?? "",
              }),
              onPress: open("/settings/legal/privacy"),
            },
          ]}
        />
        <Section
          title={t("settings.about.title")}
          rows={[
            {
              key: "version",
              title: t("settings.version.label"),
              summary:
                typeof commit === "string" && commit.length > 0
                  ? t("settings.version.commit", { commit: commit.slice(0, 7) })
                  : undefined,
              detail: typeof version === "string" && version.length > 0 ? version : "?",
            },
            {
              key: "source",
              title: t("about.source.title"),
              summary: t("settings.source.summary"),
              onPress: open("/settings/source"),
            },
            {
              key: "licenses",
              title: t("settings.licenses.label"),
              summary: t("settings.licenses.summary", { packages: LICENSES.length }),
              onPress: open("/settings/licenses"),
            },
          ]}
        />
        <Section
          title={t("settings.group.account")}
          rows={[
            // Always there: a device with no session says so on its screen, and
            // a flow signing out finds the row whatever the session is.
            {
              key: "device",
              title: t("settings.session.label"),
              summary: t("settings.device.summary"),
              onPress: open("/settings/device"),
            },
            ...(signedIn
              ? [
                  {
                    key: "email",
                    title: t("settings.email.label"),
                    summary: t("settings.email.summary"),
                    onPress: open("/settings/email"),
                  },
                  {
                    key: "account",
                    title: t("account.title"),
                    summary: t("settings.account.summary"),
                    onPress: open("/settings/account"),
                  },
                ]
              : []),
          ]}
        />
      </ScrollView>
    </SafeAreaView>
  );
}
