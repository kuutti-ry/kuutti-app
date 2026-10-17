import { CONSENT_VERSIONS } from "@kuutti/i18n";
import type { ConsentsResponse, WithdrawableConsentKind } from "@kuutti/schema";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { LoadFailed } from "@/components/LoadFailed";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { LegalTextLink } from "./LegalTextLink";
import { consentLocale, fetchConsents, giveConsent, withdrawConsent } from "./onboarding/client";
import { useSession } from "./session";

export type ConsentState = "loading" | "unavailable" | "on" | "off" | "outdated";

const bundledVersion = (kind: WithdrawableConsentKind): string => CONSENT_VERSIONS[kind] ?? "";

/**
 * A withdrawable consent as the API holds it (#46, #146, ADR-010 §4): on when
 * an active consent of the kind names the current wording, off otherwise, and
 * outdated when the wording built into this app is older than the API's: no
 * consent for a text this app never showed.
 */
function stateOf(kind: WithdrawableConsentKind, consents: ConsentsResponse): ConsentState {
  const current = consents.currentVersions[kind];
  if (bundledVersion(kind) !== current) return "outdated";
  const active = consents.consents.some(
    (c) => c.kind === kind && c.withdrawnAt === null && c.version === current,
  );
  return active ? "on" : "off";
}

/**
 * One consent as a switch: a change is a POST or a DELETE, both answered
 * with the consents as stored. Withdrawing the special-category consent takes
 * the seek answer with it, and onboarding asks it again (ADR-019 §4).
 */
function useConsentSwitch(kind: WithdrawableConsentKind, signedIn: boolean, locale: string) {
  const [state, setState] = useState<ConsentState>("loading");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const read = useCallback(() => {
    setState("loading");
    fetchConsents().then(
      (consents) => mounted.current && setState(stateOf(kind, consents)),
      (failure: unknown) => {
        if (!mounted.current) return;
        setError(failure);
        setState("unavailable");
      },
    );
  }, [kind]);
  useEffect(() => {
    if (signedIn) read();
  }, [signedIn, read]);
  const set = useCallback(
    async (on: boolean) => {
      setBusy(true);
      setFailed(false);
      try {
        const consents = on
          ? await giveConsent(kind, bundledVersion(kind), consentLocale(locale))
          : await withdrawConsent(kind);
        if (mounted.current) setState(stateOf(kind, consents));
      } catch {
        if (mounted.current) setFailed(true);
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [kind, locale],
  );
  return { state, error, busy, failed, set, read };
}

const LABEL = {
  research: "account.research.label",
  special_category: "account.specialCategory.label",
} as const;
const EXPLAIN = {
  research: "account.research.explain",
  special_category: "account.specialCategory.explain",
} as const;
const FAILED = {
  research: "account.research.failed",
  special_category: "account.specialCategory.failed",
} as const;

/**
 * One withdrawable consent on its own screen (#46, #146, #287): a choice
 * about the app, not an action on the account. It says when it is being read
 * and when it could not be read, with a way to read it again; nothing for a
 * signed-out device, whose screen says there is no session. A yes here is
 * given to the version this app carries, so its text is a link away, as on
 * the onboarding steps (#208, ADR-010 §4).
 */
export function ConsentSwitch({ kind }: { kind: WithdrawableConsentKind }) {
  const { t, locale } = useT();
  const tap = useHapticTap();
  const session = useSession();
  const consent = useConsentSwitch(kind, session.status === "signed-in", locale);
  if (session.status !== "signed-in") return null;
  if (consent.state === "loading") {
    return (
      <Text variant="muted" accessibilityLiveRegion="polite">
        {t("account.choices.loading")}
      </Text>
    );
  }
  if (consent.state === "unavailable") {
    return (
      <LoadFailed
        headline={t("account.choices.loadFailed")}
        error={consent.error}
        onRetry={consent.read}
      />
    );
  }
  const label = t(LABEL[kind]);
  const locked = consent.busy || consent.state === "outdated";
  const set = (on: boolean) => {
    tap();
    void consent.set(on);
  };
  return (
    <View className="gap-2">
      {/* The words toggle the switch too, as the high-contrast row's do: a
          thumb or a test reaches them without aiming at the thumb-sized
          switch at the screen's edge. */}
      <View className="flex-row items-center justify-between gap-3">
        <Label onPress={() => !locked && set(consent.state !== "on")}>{label}</Label>
        <Switch
          accessibilityLabel={label}
          checked={consent.state === "on"}
          disabled={locked}
          onCheckedChange={set}
        />
      </View>
      <Text variant="muted">
        {consent.state === "outdated" ? t("onboarding.consents.outdatedApp") : t(EXPLAIN[kind])}
      </Text>
      <LegalTextLink kind={kind} />
      {consent.failed && <Text accessibilityLiveRegion="assertive">{t(FAILED[kind])}</Text>}
    </View>
  );
}

/**
 * Both consents' states, for the rows of the settings list that open them
 * (#287): read once, and again whenever the list is back in front, so a
 * change made on a consent's screen shows there. "loading" before a person
 * signs in and while the read is on its way, "unavailable" when it failed.
 */
export function useConsentStates(): Record<WithdrawableConsentKind, ConsentState> {
  const session = useSession();
  const signedIn = session.status === "signed-in";
  const [states, setStates] = useState<Record<WithdrawableConsentKind, ConsentState>>({
    research: "loading",
    special_category: "loading",
  });
  useFocusEffect(
    useCallback(() => {
      if (!signedIn) return;
      let live = true;
      fetchConsents().then(
        (consents) =>
          live &&
          setStates({
            research: stateOf("research", consents),
            special_category: stateOf("special_category", consents),
          }),
        () => live && setStates({ research: "unavailable", special_category: "unavailable" }),
      );
      return () => {
        live = false;
      };
    }, [signedIn]),
  );
  return states;
}
