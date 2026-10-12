import type { PlainMessageKey } from "@kuutti/i18n";
import { useState } from "react";
import { Linking, View } from "react-native";
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
 * What a screen shows when something did not load: its own line saying what,
 * then why in words, and the way out that fits. Trying again helps when the
 * network or the server failed; an app older than its API needs the newest
 * update instead, and when this build has none, a new install.
 */
export function LoadFailed({
  headline,
  error,
  onRetry,
}: {
  /** The screen's own words for what did not load. */
  headline: string;
  error: unknown;
  onRetry: () => void;
}) {
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
      <Text accessibilityLiveRegion="assertive" className="text-center">
        {headline}
      </Text>
      <Text className="text-center">{t(WHY[kind])}</Text>
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
