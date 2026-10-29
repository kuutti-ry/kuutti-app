import { CONSENT_VERSIONS, LOCALE_NAMES } from "@kuutti/i18n";
import type { WithdrawableConsentKind } from "@kuutti/schema";
import { useLocalSearchParams, useRouter } from "expo-router";
import CircleAlert from "lucide-react-native/icons/circle-alert";
import type { ReactNode } from "react";
import { AccessibilityInfo, Keyboard, Platform, View } from "react-native";
import { type Row, RowGroup } from "@/components/RowGroup";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useContactsSummary, YourContacts } from "@/features/chat";
import {
  AccountActions,
  type ConsentState,
  ConsentSwitch,
  EmailCard,
  ExportData,
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
import { useOpenRow } from "./open-rows";
import { PhotoDescriptionChoices } from "./PhotoDescriptionChoices";
import { ROW_ICONS } from "./row-icons";
import { SettingsPage, useReveal } from "./SettingsPage";
import { SourcePanel } from "./SourcePanel";
import { ThemeChoices } from "./ThemeChoices";

/** The title of a consent's row (#287): the settings' own words, in every language. */
const CONSENT_TITLE = {
  research: "settings.research.title",
  special_category: "settings.sensitive.title",
} as const;

/** The mark of a setting that does not do what it says (#511): its words are in the row's value. */
const ALERT = <Icon as={CircleAlert} testID="row-alert" className="mt-0.5 text-foreground" />;

/** A heading and its rows; a section with no rows (signed out) is not drawn. */
function Section({ title, rows }: { title: string; rows: readonly Row[] }) {
  if (rows.length === 0) return null;
  return (
    <View className="gap-2">
      <Text variant="large" role="heading" aria-level="2">
        {title}
      </Text>
      <RowGroup rows={rows} />
    </View>
  );
}

/**
 * The person's own settings, after login, in every build (#143): one long
 * list in six sections (#511): appearance and language; notifications and
 * contacts; privacy and security; community; about Kuutti; and the account
 * last, with logging out and the deletion. Every row opens what it holds
 * under itself, one row at a time, with a chevron pointing down; the
 * licences alone open a screen of their own, with a chevron pointing right,
 * since a list of every package is no setting. The row left open is the one
 * the list opens with while the app runs, and a row opened low on the list
 * is brought into sight. A row's second line is its value (the theme, a
 * consent on or off, the address, the contacts kept), never a description of
 * the row its title already names (#376), and a mark stands beside a setting
 * that does not do what it says (an address not confirmed, a consent for a
 * wording newer than the app, notifications the phone refuses); a row's
 * value reads what its panel holds and follows what the panel stores. A
 * link may name a row to open (`/settings?open=device`), which also takes a
 * screen reader's focus. The tech config screen keeps what is technical
 * beyond the version and exists outside production only.
 */
export function SettingsScreen() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const theme = useTheme();
  const locale = useLocaleSettings();
  const session = useSession();
  const { open: link } = useLocalSearchParams<{ open?: string | string[] }>();
  const asked = typeof link === "string" ? link : undefined;
  const { open, opened, toggle } = useOpenRow(asked);
  const { scrollProps, reveal } = useReveal();
  const signedIn = session.status === "signed-in";

  /** A row that holds its setting, open or closed, with its picture. */
  const holding = (key: string, panel: ReactNode) => ({
    key,
    panel,
    icon: ROW_ICONS[key],
    expanded: open === key,
    kept: opened.has(key),
    onPress: () => {
      tap();
      // A field left as its row is pressed counts as left (#511): the keyboard goes, and the field saves.
      Keyboard.dismiss();
      toggle(key);
    },
    onOpened: ({ wrapper, header }: { wrapper: View; header: View }) => {
      reveal(wrapper);
      if (key === asked) AccessibilityInfo.sendAccessibilityEvent(header, "focus");
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
      mark: consents.states[kind] === "outdated" ? ALERT : undefined,
    };
  };
  const only = (yes: boolean, rows: Row[]): Row[] => (yes ? rows : []);

  return (
    <SettingsPage title={t("settings.title")} scrollProps={scrollProps}>
      <View className="gap-8">
        <Section
          title={t("settings.section.appearance")}
          rows={[
            // The language first: somebody who chose one they cannot read finds it at the top.
            {
              ...holding("language", <LanguageChoices />),
              title: t("settings.language.label"),
              summary: languageSummary,
              value: languageSummary,
            },
            {
              ...holding("theme", <ThemeChoices />),
              title: t("settings.theme.label"),
              summary: themeSummary,
              value: themeSummary,
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
          title={t("settings.section.contact")}
          rows={only(signedIn, [
            {
              ...holding("notifications", <NotificationChoices onStored={notifications.stored} />),
              title: t("settings.notifications.label"),
              summary: notifications.summary,
              value: notifications.summary,
              mark: notifications.alert ? ALERT : undefined,
            },
            {
              ...holding("email", <EmailCard inRow onStored={email.stored} />),
              title: t("settings.email.label"),
              summary: email.summary,
              value: email.summary,
              mark: email.alert ? ALERT : undefined,
            },
            {
              ...holding("contacts", <YourContacts onStored={contacts.stored} />),
              title: t("settings.contacts.label"),
              summary: contacts.summary,
              value: contacts.summary,
            },
          ])}
        />
        <Section
          title={t("settings.section.security")}
          rows={[
            // The lock is this phone's (#418); the web preview has none.
            ...only(signedIn && Platform.OS !== "web", [
              {
                ...holding("lock", <LockControls />),
                title: t("settings.lock.label"),
                summary: lockWords,
                value: lockWords,
              },
            ]),
            // The two withdrawable consents, each saying whether it is on; nothing signed out.
            ...only(signedIn, [
              consentRow("research"),
              consentRow("special_category"),
              {
                ...holding("export", <ExportData />),
                title: t("settings.export.label"),
              },
            ]),
          ]}
        />
        <Section
          title={t("settings.section.community")}
          rows={only(signedIn, [
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
          ])}
        />
        <Section
          title={t("settings.about.title")}
          rows={[
            {
              key: "version",
              icon: ROW_ICONS.version,
              title: t("settings.version.label"),
              summary: commit
                ? t("settings.version.commit", { commit: commit.slice(0, 7) })
                : undefined,
              detail: version ?? "?",
            },
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
            {
              ...holding("source", <SourcePanel />),
              title: t("about.source.title"),
            },
            {
              key: "licenses",
              icon: ROW_ICONS.licenses,
              title: t("settings.licenses.label"),
              summary: t("settings.licenses.summary", { packages: LICENCES.packages.length }),
              onPress: () => {
                tap();
                router.push("/settings/licenses");
              },
            },
          ]}
        />
        <Section
          title={t("settings.group.account")}
          rows={[
            // Always there: a device with no session says so under it, and a
            // flow signing out finds the row whatever the session is.
            {
              ...holding("device", <DeviceActions />),
              title: t("settings.session.label"),
            },
            ...only(signedIn, [
              {
                ...holding("account", <AccountActions />),
                title: t("account.title"),
              },
            ]),
          ]}
        />
      </View>
    </SettingsPage>
  );
}
