import { CONSENT_VERSIONS, LOCALE_NAMES } from "@kuutti/i18n";
import type { WithdrawableConsentKind } from "@kuutti/schema";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { Platform, View } from "react-native";
import { type Row, RowGroup } from "@/components/RowGroup";
import { Text } from "@/components/ui/text";
import { useContactsSummary, YourContacts } from "@/features/chat";
import {
  AccountActions,
  type ConsentState,
  ConsentSwitch,
  EmailCard,
  useConsentStates,
  useEmailSummary,
  useLock,
  useSession,
} from "@/features/identity";
import { NotificationChoices, useNotificationsSummary } from "@/features/notifications";
import { Invitations, useInvitationsSummary } from "@/features/rewards";
import { buildInfo } from "@/lib/build";
import { useDecisionButtons } from "@/lib/decision-buttons";
import { useLocaleSettings, useT } from "@/lib/locale";
import { usePhotoDescriptionSettings } from "@/lib/photo-descriptions";
import { useHapticTap } from "@/theme/haptics";
import { useTheme } from "@/theme/ThemeProvider";
import { SCHEMES } from "./Choice";
import { DecisionButtonChoices } from "./DecisionButtonChoices";
import { DeviceActions } from "./DeviceActions";
import { FeedbackForm } from "./FeedbackForm";
import { LanguageChoices } from "./LanguageChoices";
import { LegalSummary } from "./LegalSummary";
import { LockControls } from "./LockControls";
import { LICENCES } from "./licences";
import { useOpenRows } from "./open-rows";
import { PhotoDescriptionChoices } from "./PhotoDescriptionChoices";
import { SettingsPage } from "./SettingsPage";
import { SourcePanel } from "./SourcePanel";
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
 * list of sections (#511), in the order of #376. Every row opens what it
 * holds under itself, with a chevron pointing down, and closes it again;
 * which rows are open is kept on the phone. The licences alone open a screen
 * of their own, with a chevron pointing right: a list of every package is no
 * setting. Appearance and language (the OS's and the phone's by default,
 * kept across restarts, the photo descriptions of #296 and the decision
 * buttons of #82); the account, this device and its lock (#418), the
 * e-mail, the contacts to share in a conversation (#103), the notifications
 * (#176), the invitations (#107), the feedback to the moderators (#171), and
 * the export, the break and the deletion last (#51, #148, #170); the legal
 * part, the two consents (#46, #146) and the texts they refer to; about
 * Kuutti, the version, the source offer of AGPL-3.0 section 13 (visible to
 * everybody) and the licences. A row's second line is its value (the theme,
 * a consent on or off, the address, how many contacts are kept), never a
 * description of the row its title already names (#376); a row's value reads
 * what its panel holds and follows what the panel stores. A link may name a
 * row to open (`/settings?open=device`). The tech config screen keeps what
 * is technical beyond the version (the API, the native build, a test error)
 * and exists outside production only.
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
  const email = useEmailSummary(signedIn);
  const contacts = useContactsSummary(signedIn);
  const notifications = useNotificationsSummary(signedIn);
  const invitations = useInvitationsSummary(signedIn);
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
            ...holding("device", <DeviceActions />),
            title: t("settings.session.label"),
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
                  ...holding("email", <EmailCard inRow onStored={email.stored} />),
                  title: t("settings.email.label"),
                  summary: email.summary,
                  value: email.summary,
                },
                {
                  ...holding("contacts", <YourContacts onStored={contacts.stored} />),
                  title: t("settings.contacts.label"),
                  summary: contacts.summary,
                  value: contacts.summary,
                },
                {
                  ...holding(
                    "notifications",
                    <NotificationChoices onStored={notifications.stored} />,
                  ),
                  title: t("settings.notifications.label"),
                  summary: notifications.summary,
                  value: notifications.summary,
                },
                {
                  ...holding("invitations", <Invitations onStored={invitations.stored} />),
                  title: t("settings.invite.label"),
                  summary: invitations.summary,
                  value: invitations.summary,
                },
                {
                  ...holding("feedback", <FeedbackForm />),
                  title: t("feedback.title"),
                },
                {
                  ...holding("account", <AccountActions />),
                  title: t("account.title"),
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
            ...holding("terms", <LegalSummary kind="terms" />),
            title: t("legal.terms.title"),
            summary: t("onboarding.consents.version", { version: CONSENT_VERSIONS.terms ?? "" }),
          },
          {
            ...holding("privacy", <LegalSummary kind="privacy" />),
            title: t("legal.privacy.title"),
            summary: t("onboarding.consents.version", {
              version: CONSENT_VERSIONS.privacy ?? "",
            }),
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
            ...holding("source", <SourcePanel />),
            title: t("about.source.title"),
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
