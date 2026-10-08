import { CONSENT_VERSIONS } from "@kuutti/i18n";
import type { AccountExport, ConsentsResponse, WithdrawableConsentKind } from "@kuutti/schema";
import { useCallback, useEffect, useState } from "react";
import { Platform, Share, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { consentLocale, fetchConsents, giveConsent, withdrawConsent } from "./onboarding/client";
import { useSession } from "./session";

/** Days before the same person may register again (TD-7); the API's constant, repeated for the text. */
export const REREGISTER_COOLDOWN_DAYS = 30;

type Busy = { kind: "idle" } | { kind: "exporting" } | { kind: "deleting" };
type Notice = { kind: "export_failed" } | { kind: "delete_failed" } | null;

/**
 * Hands the export to the system share sheet on the phone; the web preview
 * has no share sheet and downloads a file instead. Injected so tests can see
 * what was handed over without a native sheet.
 */
export async function shareExport(
  data: AccountExport,
  title: string,
  share: typeof Share.share = Share.share,
): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  if (Platform.OS === "web") {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "kuutti-export.json";
    a.click();
    // The browser queues the download asynchronously; revoking at once can
    // leave it with nothing to save.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  await share({ title, message: json });
}

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
  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1">{label}</Text>
        <Switch
          accessibilityLabel={label}
          checked={consent.state === "on"}
          disabled={consent.busy || consent.state === "outdated"}
          onCheckedChange={(on) => {
            tap();
            void consent.set(on);
          }}
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
 * The account card (#51, ADR-007): the data export and the deletion, on the
 * home screen until the profile gives them a home. Deletion is a button
 * behind a confirmation that names the cooldown; never a swipe, never colour
 * alone (CLAUDE.md Accessibility).
 */
export function AccountActions({ share }: { share?: typeof Share.share }) {
  const { t, locale } = useT();
  const session = useSession();
  const tap = useHapticTap();
  const [busy, setBusy] = useState<Busy>({ kind: "idle" });
  const [notice, setNotice] = useState<Notice>(null);
  const [confirming, setConfirming] = useState(false);
  const research = useConsentSwitch("research", session.status === "signed-in", locale);
  const special = useConsentSwitch("special_category", session.status === "signed-in", locale);

  if (session.status !== "signed-in") return null;

  const exportData = async () => {
    tap();
    setNotice(null);
    setBusy({ kind: "exporting" });
    try {
      const data = await session.exportData();
      await shareExport(data, t("account.export.title"), share);
    } catch {
      setNotice({ kind: "export_failed" });
    } finally {
      setBusy({ kind: "idle" });
    }
  };

  const deleteAccount = async () => {
    setConfirming(false);
    setNotice(null);
    setBusy({ kind: "deleting" });
    try {
      await session.deleteAccount();
      // The provider flips to signed-out; this card unmounts with it.
    } catch {
      setNotice({ kind: "delete_failed" });
      setBusy({ kind: "idle" });
    }
  };

  return (
    <Card className="w-full max-w-md">
      <View accessibilityLabel={t("account.title")} className="gap-6">
        <CardHeader>
          <CardTitle>{t("account.title")}</CardTitle>
          <CardDescription>{t("account.export.explain")}</CardDescription>
        </CardHeader>
        <CardContent className="gap-3">
          {notice && (
            <Text accessibilityLiveRegion="assertive">
              {notice.kind === "export_failed"
                ? t("account.export.failed")
                : t("account.delete.failed")}
            </Text>
          )}
          {busy.kind !== "idle" && (
            <Text accessibilityLiveRegion="polite">
              {busy.kind === "exporting"
                ? t("account.export.working")
                : t("account.delete.working")}
            </Text>
          )}
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
          <Button
            variant="outline"
            accessibilityLabel={t("account.export.button")}
            disabled={busy.kind !== "idle"}
            onPress={() => void exportData()}
          >
            <Text>{t("account.export.button")}</Text>
          </Button>
          <Button
            variant="destructive"
            accessibilityLabel={t("account.delete.button")}
            disabled={busy.kind !== "idle"}
            onPress={() => {
              tap();
              setConfirming(true);
            }}
          >
            <Text>{t("account.delete.button")}</Text>
          </Button>
        </CardContent>
      </View>

      <Dialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        <DialogContent closeLabel={t("account.delete.close")}>
          <DialogHeader>
            <DialogTitle>{t("account.delete.title")}</DialogTitle>
            <DialogDescription>
              {t("account.delete.body", { days: REREGISTER_COOLDOWN_DAYS })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onPress={() => setConfirming(false)}>
              {t("account.delete.cancel")}
            </Button>
            <Button variant="destructive" onPress={() => void deleteAccount()}>
              {t("account.delete.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
