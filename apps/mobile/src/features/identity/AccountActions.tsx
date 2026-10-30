import type { PlainMessageKey } from "@kuutti/i18n";
import { Directory, File, Paths } from "expo-file-system";
import { useRouter } from "expo-router";
import { type ReactNode, useState } from "react";
import { Platform, Share, View } from "react-native";
import { Notice as Said } from "@/components/Notice";
import { Button } from "@/components/ui/button";
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

type Notice = "export_saved" | "export_failed" | "export_limited" | "delete_failed";

const NOTICE: Record<Notice, PlainMessageKey> = {
  export_saved: "account.export.saved",
  export_failed: "account.export.failed",
  export_limited: "account.export.limited",
  delete_failed: "account.delete.failed",
};

/** What expo-file-system's picker throws when the person backs out of it; not an error here. */
const PICKER_CANCELLED = "ERR_PICKER_CANCELLED";

/**
 * Hands the export file to the person (#237): the system share sheet on iOS
 * with the file's URL (and nothing else: a message beside it would come
 * along as a text.txt), a folder of their choosing on Android (React
 * Native's sheet sends text only there), a download on the web preview.
 * `getFile` asks the API, which counts one of the day's copies (#465):
 * Android asks for the folder first, so backing out spends none (the
 * picker's grant is persistable and outlives the fetch); iOS's sheet needs
 * the file, so a closed sheet spends one. iOS's copy is written to the
 * app's cache and deleted once the sheet closes: personal data does not
 * wait for the OS to purge it; Android's goes from memory into the folder.
 * `share` is injected so tests can see what was handed over without a
 * native sheet.
 */
export async function shareExport(
  getFile: () => Promise<ExportFile>,
  title: string,
  share: typeof Share.share = Share.share,
): Promise<"saved" | "cancelled"> {
  if (Platform.OS === "web") {
    const file = await getFile();
    const blob = new Blob([file.bytes as BlobPart], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    // The browser queues the download asynchronously; revoking at once can
    // leave it with nothing to save.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return "saved";
  }
  if (Platform.OS === "android") {
    let folder: Directory;
    try {
      folder = await Directory.pickDirectoryAsync();
    } catch (error) {
      if ((error as { code?: string }).code === PICKER_CANCELLED) return "cancelled";
      throw error;
    }
    const file = await getFile();
    folder.createFile(file.name, "application/zip").write(file.bytes);
    return "saved";
  }
  const file = await getFile();
  const cached = new File(Paths.cache, file.name);
  cached.write(file.bytes);
  try {
    const { action } = await share({ title, url: cached.uri });
    return action === "sharedAction" ? "saved" : "cancelled";
  } finally {
    cached.delete();
  }
}

/** What the last change came to, said under its button (#511): in words, and aloud on iOS. */
function useSaid() {
  const [said, setSaid] = useState<{ notice: Notice; answer: number } | null>(null);
  const say = (notice: Notice | null) =>
    setSaid((was) => (notice === null ? null : { notice, answer: (was?.answer ?? 0) + 1 }));
  return { said, say };
}

/**
 * A copy of what Kuutti holds about the person (#51, ADR-007; #237, #465),
 * under its row of Settings (#511): what the file is, and the one button
 * that hands it over, as the system offers it.
 */
export function ExportData({ share }: { share?: typeof Share.share }) {
  const { t } = useT();
  const session = useSession();
  // `choosing`: Android's folder picker is open and nothing is fetched yet, so nothing is said (#465).
  const [busy, setBusy] = useState<"idle" | "choosing" | "exporting">("idle");
  const { said, say } = useSaid();
  if (session.status !== "signed-in") return null;

  const exportData = async () => {
    say(null);
    setBusy("choosing");
    const getFile = () => {
      setBusy("exporting");
      return session.exportData();
    };
    try {
      const handed = await shareExport(getFile, t("account.export.title"), share);
      // Backing out is the person's own answer and needs no line (#237).
      if (handed === "saved") say("export_saved");
    } catch (error) {
      // The day's copies are used up (#237): said as the API says it, not as a failure.
      const limited = error instanceof ApiError && error.code === "export_budget_exceeded";
      say(limited ? "export_limited" : "export_failed");
    } finally {
      setBusy("idle");
    }
  };

  return (
    <View className="gap-3">
      <Text>{t("account.export.explain")}</Text>
      {busy === "exporting" && (
        <Text accessibilityLiveRegion="polite">{t("account.export.working")}</Text>
      )}
      <Button
        variant="outline"
        accessibilityLabel={t("account.export.button")}
        disabled={busy !== "idle"}
        onPress={() => void exportData()}
      >
        <Text>{t("account.export.button")}</Text>
      </Button>
      {said !== null && (
        <Said
          words={t(NOTICE[said.notice])}
          refused={said.notice !== "export_saved"}
          answer={said.answer}
        />
      )}
    </View>
  );
}

/**
 * The account (#170, ADR-022; #83, ADR-040; ADR-007), under the "Your
 * account" row of Settings (#287, #511): "Löysin hänet", the break and the
 * deletion, in that order, each with what it does under it, the deletion
 * last, below a hairline. "Löysin hänet" and the break have screens of
 * their own; deletion is a button behind a confirmation that names the
 * cooldown; never a swipe, never colour alone (CLAUDE.md Accessibility).
 */
export function AccountActions() {
  const { t } = useT();
  const session = useSession();
  const router = useRouter();
  const tap = useHapticTap();
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { said, say } = useSaid();
  if (session.status !== "signed-in") return null;

  const deleteAccount = async () => {
    setConfirming(false);
    say(null);
    setDeleting(true);
    try {
      await session.deleteAccount();
      // The provider flips to signed-out; this card unmounts with it.
    } catch {
      say("delete_failed");
      setDeleting(false);
    }
  };

  /** A button and, under it, what it does. */
  const action = (button: ReactNode, consequence: string) => (
    <View className="gap-1.5">
      {button}
      <Text variant="muted">{consequence}</Text>
    </View>
  );

  return (
    <View className="gap-4">
      {/* "Löysin hänet" (#83): telling Kuutti one found somebody, which changes nothing else. */}
      {action(
        <Button
          variant="outline"
          accessibilityLabel={t("account.foundThem.button")}
          disabled={deleting}
          onPress={() => {
            tap();
            router.push("/settings/found-them");
          }}
        >
          <Text>{t("account.foundThem.button")}</Text>
        </Button>,
        t("account.found.consequence"),
      )}
      {/* Taking a break (#170): the screen says what happens before anything does. */}
      {action(
        <Button
          variant="outline"
          accessibilityLabel={t("account.break.button")}
          disabled={deleting}
          onPress={() => {
            tap();
            router.push("/account/break");
          }}
        >
          <Text>{t("account.break.button")}</Text>
        </Button>,
        t("account.break.consequence"),
      )}
      <View className="mt-3 gap-3 border-t border-border pt-4">
        {deleting && <Text accessibilityLiveRegion="polite">{t("account.delete.working")}</Text>}
        {action(
          <Button
            variant="destructive"
            accessibilityLabel={t("account.delete.button")}
            disabled={deleting}
            onPress={() => {
              tap();
              setConfirming(true);
            }}
          >
            <Text>{t("account.delete.button")}</Text>
          </Button>,
          t("account.delete.consequence", { days: REREGISTER_COOLDOWN_DAYS }),
        )}
        {said !== null && <Said refused words={t(NOTICE[said.notice])} answer={said.answer} />}
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
    </View>
  );
}
