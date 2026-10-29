import { CONSENT_VERSIONS, LOCALE_NAMES } from "@kuutti/i18n";
import type { WithdrawableConsentKind } from "@kuutti/schema";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { Platform, View } from "react-native";
import { type Row, RowGroup } from "@/components/RowGroup";
import { Text } from "@/components/ui/text";
import { YourContacts } from "@/features/chat";
import {
  type ConsentState,
  ConsentSwitch,
  useConsentStates,
  useLock,
  useSession,
} from "@/features/identity";
import { NotificationChoices } from "@/features/notifications";
import { buildInfo } from "@/lib/build";
import { useDecisionButtons } from "@/lib/decision-buttons";
import { useLocaleSettings, useT } from "@/lib/locale";
import { usePhotoDescriptionSettings } from "@/lib/photo-descriptions";
import { useHapticTap } from "@/theme/haptics";
import { useTheme } from "@/theme/ThemeProvider";
import { SCHEMES } from "./Choice";
import { DecisionButtonChoices } from "./DecisionButtonChoices";
import { LanguageChoices } from "./LanguageChoices";
import { LockControls } from "./LockControls";
import { LICENCES } from "./licences";
import { useOpenRows } from "./open-rows";
import { PhotoDescriptionChoices } from "./PhotoDescriptionChoices";
import { SettingsPage } from "./SettingsPage";
import { ThemeChoices } from "./ThemeChoices";

/** The title of a consent's row (#287): the settings' own words, in every language. */
const CONSENT_TITLE = {
  research: "settings.research.title",
  special_category: "settings.sensitive.title",
} as const;

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
 * The person's own settings, after login, in every build (#143): one long
 * list of sections (#511), in the order of #376. A setting that is chosen
 * in place opens under its row, with a chevron pointing down, and closes
 * again; which rows are open is kept on the phone. A row that starts a flow
 * of its own (a code to confirm, a form, a text to read) still opens its
 * screen, with a chevron pointing right. Appearance and language (the OS's
 * and the phone's by default, kept across restarts, the photo descriptions
 * of #296 and the decision buttons of #82); the account, this device and its
 * lock (#418), the e-mail, the contacts to share in a conversation (#103),
 * the notifications (#176), the invitations (#107), the feedback to the
 * moderators (#171), and the export, the break and the deletion last (#51,
 * #148, #170); the legal part, the two consents (#46, #146) and the texts
 * they refer to; about Kuutti, the version, the source offer of AGPL-3.0
 * section 13 (visible to everybody) and the licences. A row's second line is
 * its value (the theme, a consent on or off, a version), never a description
 * of the row its title already names (#376). A link may name a row to open
 * (`/settings?open=photoDescriptions`). The tech config screen keeps what is
 * technical beyond the version (the API, the native build, a test error) and
 * exists outside production only.
 */
export function SettingsScreen() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const theme = useTheme();
  const locale = useLocaleSettings();
  const session = useSession();
  const { open: asked } = useLocalSearchParams<{ open?: string | string[] }>();
  const { open, toggle } = useOpenRows(typeof asked === "string" ? asked : undefined);
  const go = (path: Parameters<typeof router.push>[0]) => () => {
    tap();
    router.push(path);
  };
  /** A row that holds its setting, open or closed. */
  const holding = (key: string, panel: ReactNode) => ({
    key,
    panel,
    expanded: open.has(key),
    onPress: () => {
      tap();
      toggle(key);
    },
  });

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
  // The automatic descriptions (#296): under the photos or read only; the parts chosen are in the row.
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
  const consentRow = (kind: WithdrawableConsentKind): Row => {
    const words = consentWords(consents.states[kind]);
    return {
      ...holding(kind, <ConsentSwitch kind={kind} onStored={consents.stored} />),
      title: t(CONSENT_TITLE[kind]),
      summary: words,
      value: words,
    };
  };

  return (
    <SettingsPage title={t("settings.title")}>
      <Section
        title={t("settings.section.appearance")}
        rows={[
          {
            ...holding("theme", <ThemeChoices />),
            title: t("settings.theme.label"),
            summary: themeSummary,
            value: themeSummary,
          },
          {
            ...holding("language", <LanguageChoices />),
            title: t("settings.language.label"),
            summary: languageSummary,
            value: languageSummary,
          },
          {
            ...holding("photoDescriptions", <PhotoDescriptionChoices />),
            title: t("settings.photoDescriptions.label"),
            summary: descriptionsSummary,
            value: descriptionsSummary,
          },
          {
            ...holding("decisionButtons", <DecisionButtonChoices />),
            title: t("settings.decisionButtons.label"),
            summary: buttonsSummary,
            value: buttonsSummary,
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
            onPress: go("/settings/device"),
          },
          // The lock is this phone's, beside its session (#418); the web preview has none.
          ...(signedIn && Platform.OS !== "web"
            ? [
                {
                  ...holding("lock", <LockControls />),
                  title: t("settings.lock.label"),
                  summary: lockWords,
                  value: lockWords,
                },
              ]
            : []),
          ...(signedIn
            ? [
                {
                  key: "email",
                  title: t("settings.email.label"),
                  onPress: go("/settings/email"),
                },
                {
                  ...holding("contacts", <YourContacts />),
                  title: t("settings.contacts.label"),
                },
                {
                  ...holding("notifications", <NotificationChoices />),
                  title: t("settings.notifications.label"),
                },
                {
                  key: "invitations",
                  title: t("settings.invite.label"),
                  onPress: go("/settings/invite"),
                },
                {
                  key: "feedback",
                  title: t("feedback.title"),
                  onPress: go("/settings/feedback"),
                },
                {
                  key: "account",
                  title: t("account.title"),
                  onPress: go("/settings/account"),
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
            onPress: go("/settings/legal/terms"),
          },
          {
            key: "privacy",
            title: t("legal.privacy.title"),
            summary: t("onboarding.consents.version", {
              version: CONSENT_VERSIONS.privacy ?? "",
            }),
            onPress: go("/settings/legal/privacy"),
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
            onPress: go("/settings/source"),
          },
          {
            key: "licenses",
            title: t("settings.licenses.label"),
            summary: t("settings.licenses.summary", { packages: LICENCES.packages.length }),
            onPress: go("/settings/licenses"),
          },
        ]}
      />
    </SettingsPage>
  );
}
