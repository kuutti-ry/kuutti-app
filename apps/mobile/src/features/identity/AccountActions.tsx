import { Directory, File, Paths } from "expo-file-system";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Platform, Share, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Text } from "@/components/ui/text";
import { ApiError } from "@/lib/api";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { type ExportFile, useSession } from "./session";

/** Days before the same person may register again (TD-7); the API's constant, repeated for the text. */
const REREGISTER_COOLDOWN_DAYS = 30;

type Busy = { kind: "idle" } | { kind: "exporting" } | { kind: "deleting" };
type Notice =
  | { kind: "export_failed" }
  | { kind: "export_limited" }
  | { kind: "delete_failed" }
  | null;

/** What expo-file-system's picker throws when the person backs out of it; not an error here. */
const PICKER_CANCELLED = "ERR_PICKER_CANCELLED";

/**
 * Hands the export file to the person (#237): the system share sheet on iOS
 * with the file's URL (and nothing else: a message beside it would come
 * along as a text.txt), a folder of their choosing on Android (React
 * Native's sheet sends text only there), a download on the web preview. The
 * phone's copy is written to the app's cache and deleted once the sheet
 * closes: personal data does not wait for the OS to purge it. Injected so
 * tests can see what was handed over without a native sheet.
 */
export async function shareExport(
  file: ExportFile,
  title: string,
  share: typeof Share.share = Share.share,
): Promise<void> {
  if (Platform.OS === "web") {
    const blob = new Blob([file.bytes as BlobPart], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    // The browser queues the download asynchronously; revoking at once can
    // leave it with nothing to save.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  if (Platform.OS === "android") {
    let folder: Directory;
    try {
      folder = await Directory.pickDirectoryAsync();
    } catch (error) {
      if ((error as { code?: string }).code === PICKER_CANCELLED) return;
      throw error;
    }
    folder.createFile(file.name, "application/zip").write(file.bytes);
    return;
  }
  const cached = new File(Paths.cache, file.name);
  cached.write(file.bytes);
  try {
    await share({ title, url: cached.uri });
  } finally {
    cached.delete();
  }
}

/**
 * The account card (#51, ADR-007; #170, ADR-022), on its own screen behind
 * the "Your account" row of Settings (#287): the data export, the break and
 * the deletion. The break has a
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
      const file = await session.exportData();
      await shareExport(file, t("account.export.title"), share);
    } catch (error) {
      // The day's copies are used up (#237): said as the API says it, not as a failure.
      const limited = error instanceof ApiError && error.code === "export_budget_exceeded";
      setNotice({ kind: limited ? "export_limited" : "export_failed" });
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
      <View className="gap-6">
        {/* The screen carries the title (#287); the card says what the export is. */}
        <CardHeader>
          <CardDescription>{t("account.export.explain")}</CardDescription>
        </CardHeader>
        <CardContent className="gap-3">
          {notice && (
            <Text accessibilityLiveRegion="assertive">
              {notice.kind === "export_failed"
                ? t("account.export.failed")
                : notice.kind === "export_limited"
                  ? t("account.export.limited")
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
