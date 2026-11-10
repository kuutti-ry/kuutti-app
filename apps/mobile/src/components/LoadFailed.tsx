import type { PlainMessageKey } from "@kuutti/i18n";
import { useState } from "react";
import { Linking, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Notice } from "@/components/Notice";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { updateApp } from "@/lib/app-update";
import { isProduction } from "@/lib/environment";
import { type FailureKind, failureKind } from "@/lib/failure";
import { useT } from "@/lib/locale";

const WHY: Record<FailureKind, PlainMessageKey> = {
  offline: "load.failed.offline",
  server: "load.failed.server",
  outdated: "load.failed.outdated",
  other: "load.failed.other",
};

// shortcut: outside production the team installs builds from the EAS builds
// page; production has no link until the app is in the stores (#193), and
// says in words to install the newest version.
const INSTALL_PAGE = "https://expo.dev/accounts/kuutti/projects/kuutti/builds";

/**
 * What a screen shows when something did not load: why in words, heard at once,
 * and the way out that fits (#581). Trying again helps when the network or the
 * server failed; an app older than its API needs the newest update instead, and
 * when this build has none, a new install.
 */
export function LoadFailed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useT();
  const kind = failureKind(error);
  const [update, setUpdate] = useState<"idle" | "busy" | "none">("idle");

  const runUpdate = async () => {
    setUpdate("busy");
    // On "restarting" the app is gone before anything renders again.
    if ((await updateApp()) === "none") setUpdate("none");
  };

  return (
    <View className="items-center gap-4">
      <Notice refused words={t(WHY[kind])} className="text-center" />
      {kind !== "outdated" && <Button onPress={onRetry}>{t("load.retry")}</Button>}
      {kind === "outdated" && update !== "none" && (
        <Button disabled={update === "busy"} onPress={() => void runUpdate()}>
          {update === "busy" ? t("load.updating") : t("load.update")}
        </Button>
      )}
      {kind === "outdated" && update === "none" && (
        <>
          <Text accessibilityLiveRegion="polite" className="text-center">
            {t("load.noUpdate")}
          </Text>
          {!isProduction() && (
            <Button variant="outline" onPress={() => void Linking.openURL(INSTALL_PAGE)}>
              {t("load.install")}
            </Button>
          )}
        </>
      )}
    </View>
  );
}

/** A whole screen while its first read is on its way: the words alone, centred, heard once. */
export function LoadingScreen() {
  const { t } = useT();
  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 items-center justify-center p-6">
        <Text accessibilityLiveRegion="polite">{t("load.loading")}</Text>
      </View>
    </SafeAreaView>
  );
}

/** A whole screen whose first read failed: LoadFailed, centred. */
export function LoadFailedScreen({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 items-center justify-center gap-4 p-6">
        <LoadFailed error={error} onRetry={onRetry} />
      </View>
    </SafeAreaView>
  );
}
