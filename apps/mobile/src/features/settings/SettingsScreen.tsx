import { CONSENT_VERSIONS, LOCALE_NAMES } from "@kuutti/i18n";
import { useRouter } from "expo-router";
import { Platform, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { type Row, RowGroup } from "@/components/RowGroup";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Text } from "@/components/ui/text";
import { type ConsentState, useConsentStates, useLock, useSession } from "@/features/identity";
import LICENSES from "@/generated/licenses.json";
import { buildInfo } from "@/lib/build";
import { useDecisionButtons } from "@/lib/decision-buttons";
import { useLocaleSettings, useT } from "@/lib/locale";
import { usePhotoDescriptionSettings } from "@/lib/photo-descriptions";
import { useHapticTap } from "@/theme/haptics";
import { useTheme } from "@/theme/ThemeProvider";
import { SCHEMES } from "./Choice";
import { CONSENT_TITLE } from "./ConsentScreen";

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
 * screen of its own, in the order of #376. Appearance and language (the OS's
 * and the phone's by default, kept across restarts, and the photo
 * descriptions of #296); the account, this device and its lock (#418), the
 * e-mail, the contacts to share in a conversation (#103), the notifications
 * (#176), the invitations (#107), the feedback to the moderators (#171), and
 * the export, the break and the deletion last (#51, #148, #170); the legal
 * part, the two consents (#46, #146) and the texts they refer to; about
 * Kuutti, the version, the source offer of AGPL-3.0 section 13 (visible to
 * everybody) and the licences. A row's second line is its value (the theme, a
 * consent on or off, a version), never a description of the row its title
 * already names (#376). The tech config screen keeps what is technical beyond
 * the version (the API, the native build, a test error) and exists outside
 * production only.
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
  // The automatic descriptions (#296): under the photos or read only; the parts chosen are on the screen.
  const descriptionsSummary = usePhotoDescriptionSettings().settings.shown
    ? t("settings.photoDescriptions.shown")
    : t("settings.photoDescriptions.notShown");
  const buttons = useDecisionButtons().settings;
  const handName = t(
    buttons.hand === "left" ? "settings.decisionButtons.left" : "settings.decisionButtons.right",
  );
  const buttonsSummary = buttons.oneHanded
    ? t("settings.decisionButtons.withOneHanded", { hand: handName })
    : handName;
  const { version, commit } = buildInfo();
  const signedIn = session.status === "signed-in";
  const lockWords = useLock().settings === null ? t("settings.state.off") : t("settings.state.on");
  const consents = useConsentStates();
  /** A consent's state in words, for its row; nothing while it is unknown. */
  const consentWords = (state: ConsentState): string | undefined =>
    state === "on"
      ? t("settings.state.on")
      : state === "off"
        ? t("settings.state.off")
        : state === "outdated"
          ? t("settings.state.outdated")
          : undefined;
  const consentRow = (kind: "research" | "special_category"): Row => {
    const words = consentWords(consents[kind]);
    return {
      key: kind,
      title: t(CONSENT_TITLE[kind]),
      summary: words,
      value: words,
      onPress: open(`/settings/consent/${kind}`),
    };
  };

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
              value: themeSummary,
              onPress: open("/settings/theme"),
            },
            {
              key: "language",
              title: t("settings.language.label"),
              summary: languageSummary,
              value: languageSummary,
              onPress: open("/settings/language"),
            },
            {
              key: "photoDescriptions",
              title: t("settings.photoDescriptions.label"),
              summary: descriptionsSummary,
              value: descriptionsSummary,
              onPress: open("/settings/photo-descriptions"),
            },
            {
              key: "decisionButtons",
              title: t("settings.decisionButtons.label"),
              summary: buttonsSummary,
              value: buttonsSummary,
              onPress: open("/settings/decision-buttons"),
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
              onPress: open("/settings/device"),
            },
            // The lock is this phone's, beside its session (#418); the web preview has none.
            ...(signedIn && Platform.OS !== "web"
              ? [
                  {
                    key: "lock",
                    title: t("settings.lock.label"),
                    summary: lockWords,
                    value: lockWords,
                    onPress: open("/settings/lock"),
                  },
                ]
              : []),
            ...(signedIn
              ? [
                  {
                    key: "email",
                    title: t("settings.email.label"),
                    onPress: open("/settings/email"),
                  },
                  {
                    key: "contacts",
                    title: t("settings.contacts.label"),
                    onPress: open("/settings/contacts"),
                  },
                  {
                    key: "notifications",
                    title: t("settings.notifications.label"),
                    onPress: open("/settings/notifications"),
                  },
                  {
                    key: "invitations",
                    title: t("settings.invite.label"),
                    onPress: open("/settings/invite"),
                  },
                  {
                    key: "feedback",
                    title: t("feedback.title"),
                    onPress: open("/settings/feedback"),
                  },
                  {
                    key: "account",
                    title: t("account.title"),
                    onPress: open("/settings/account"),
                  },
                ]
              : []),
          ]}
        />
        <Section
          title={t("settings.section.agreements")}
          rows={[
            // The two withdrawable consents, each saying whether it is on; nothing signed out.
            ...(signedIn ? [consentRow("research"), consentRow("special_category")] : []),
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
              summary: commit
                ? t("settings.version.commit", { commit: commit.slice(0, 7) })
                : undefined,
              detail: version ?? "?",
            },
            {
              key: "source",
              title: t("about.source.title"),
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
      </ScrollView>
    </SafeAreaView>
  );
}
