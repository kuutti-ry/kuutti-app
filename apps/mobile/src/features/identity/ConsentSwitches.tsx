import { CONSENT_VERSIONS } from "@kuutti/i18n";
import type { ConsentsResponse, WithdrawableConsentKind } from "@kuutti/schema";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { consentLocale, fetchConsents, giveConsent, withdrawConsent } from "./onboarding/client";
import { useSession } from "./session";

type ConsentState = "loading" | "unavailable" | "on" | "off" | "outdated";

const bundledVersion = (kind: WithdrawableConsentKind): string => CONSENT_VERSIONS[kind] ?? "";

/**
 * A withdrawable consent as a switch on the account card (#46, #146, ADR-010
 * §4): on when an active consent of the kind names the current wording, off
 * otherwise; a change is a POST or a DELETE, both answered with the consents
 * as stored. When the wording built into this app is older than the API's,
 * the switch is locked with the "update the app" line: no consent for a text
 * this app never showed. Withdrawing the special-category consent takes the
 * seek answer with it, and onboarding asks it again (ADR-019 §4).
 */
function useConsentSwitch(kind: WithdrawableConsentKind, signedIn: boolean, locale: string) {
  const [state, setState] = useState<ConsentState>("loading");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const apply = useCallback(
    (consents: ConsentsResponse) => {
      const current = consents.currentVersions[kind];
      if (bundledVersion(kind) !== current) {
        setState("outdated");
        return;
      }
      const active = consents.consents.some(
        (c) => c.kind === kind && c.withdrawnAt === null && c.version === current,
      );
      setState(active ? "on" : "off");
    },
    [kind],
  );
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    fetchConsents()
      .then((consents) => live && apply(consents))
      .catch(() => live && setState("unavailable"));
    return () => {
      live = false;
    };
  }, [signedIn, apply]);
  const set = useCallback(
    async (on: boolean) => {
      setBusy(true);
      setFailed(false);
      try {
        apply(
          on
            ? await giveConsent(kind, bundledVersion(kind), consentLocale(locale))
            : await withdrawConsent(kind),
        );
      } catch {
        setFailed(true);
      } finally {
        setBusy(false);
      }
    },
    [apply, kind, locale],
  );
  return { state, busy, failed, set };
}

function ConsentSwitch({
  consent,
  label,
  explain,
}: {
  consent: ReturnType<typeof useConsentSwitch>;
  label: string;
  explain: string;
}) {
  const { t } = useT();
  const tap = useHapticTap();
  if (consent.state !== "on" && consent.state !== "off" && consent.state !== "outdated") {
    return null;
  }
  const locked = consent.busy || consent.state === "outdated";
  const set = (on: boolean) => {
    tap();
    void consent.set(on);
  };
  return (
    <View className="gap-2">
      {/* The words toggle the switch too, as the high-contrast row's do: the
          whole row is the target, which a thumb or a test reaches without
          aiming at the thumb-sized switch at the screen's edge. */}
      <View className="flex-row items-center justify-between gap-3">
        <Label className="flex-1" onPress={() => !locked && set(consent.state !== "on")}>
          {label}
        </Label>
        <Switch
          accessibilityLabel={label}
          checked={consent.state === "on"}
          disabled={locked}
          onCheckedChange={set}
        />
      </View>
      <Text variant="muted">
        {consent.state === "outdated" ? t("onboarding.consents.outdatedApp") : explain}
      </Text>
      {consent.failed && (
        <Text accessibilityLiveRegion="assertive">{t("account.research.failed")}</Text>
      )}
    </View>
  );
}

/**
 * The two withdrawable consents as switches, under "App settings" (#170, the
 * S-Pankki grouping): a choice about the app, not an action on the account.
 * Nothing for a signed-out device.
 */
export function ConsentSwitches() {
  const { t, locale } = useT();
  const session = useSession();
  const research = useConsentSwitch("research", session.status === "signed-in", locale);
  const special = useConsentSwitch("special_category", session.status === "signed-in", locale);
  if (session.status !== "signed-in") return null;
  return (
    <View className="gap-4">
      <ConsentSwitch
        consent={research}
        label={t("account.research.label")}
        explain={t("account.research.explain")}
      />
      <ConsentSwitch
        consent={special}
        label={t("account.specialCategory.label")}
        explain={t("account.specialCategory.explain")}
      />
    </View>
  );
}
