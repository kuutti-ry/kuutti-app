import type { AccountExport } from "@kuutti/schema";
import { useRouter } from "expo-router";
import { useState } from "react";
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
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
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

/**
 * The account card (#51, ADR-007; #170, ADR-022), under "Account" in
 * Settings: the data export, the break and the deletion. The break has a
 * screen of its own with its consequences; deletion is a button behind a
 * confirmation that names the cooldown; never a swipe, never colour alone
 * (CLAUDE.md Accessibility).
 */
export function AccountActions({ share }: { share?: typeof Share.share }) {
  const { t } = useT();
  const session = useSession();
  const router = useRouter();
  const tap = useHapticTap();
  const [busy, setBusy] = useState<Busy>({ kind: "idle" });
  const [notice, setNotice] = useState<Notice>(null);
  const [confirming, setConfirming] = useState(false);

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
          <Button
            variant="outline"
            accessibilityLabel={t("account.export.button")}
            disabled={busy.kind !== "idle"}
            onPress={() => void exportData()}
          >
            <Text>{t("account.export.button")}</Text>
          </Button>
          {/* Taking a break (#170): the screen says what happens before anything does. */}
          <Button
            variant="outline"
            accessibilityLabel={t("account.break.button")}
            disabled={busy.kind !== "idle"}
            onPress={() => {
              tap();
              router.push("/account/break");
            }}
          >
            <Text>{t("account.break.button")}</Text>
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
