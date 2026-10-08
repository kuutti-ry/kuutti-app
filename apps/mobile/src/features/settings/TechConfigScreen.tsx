import { formatDate } from "@kuutti/i18n";
import type { HealthResponse } from "@kuutti/schema";
import * as Sentry from "@sentry/react-native";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import * as Updates from "expo-updates";
import ArrowLeft from "lucide-react-native/icons/arrow-left";
import ExternalLink from "lucide-react-native/icons/external-link";
import { useCallback, useEffect, useState } from "react";
import { Linking, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import LICENSES from "@/generated/licenses.json";
import { apiBaseUrl, fetchHealth } from "@/lib/api";
import { appEnvironment, isProduction } from "@/lib/environment";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { SourceOffer } from "./SourceOffer";

type State =
  | { kind: "loading" }
  | { kind: "ok"; health: HealthResponse }
  | { kind: "error"; message: string };

/** Where a build's version is explained: the releases of the repository. */
const RELEASES_URL = "https://github.com/kuutti-ry/kuutti-app/releases";

/**
 * Everything technical about the running app, for the team and for anybody
 * who installs a staging build (#143; the team's notes of 08/10): the
 * environment, the API's address and health, the two commits, the native
 * build and the update it runs, the version with its releases page, a test
 * error for the error tracker, and the licences of the packages. It exists
 * outside production only; the store's build has the route and shows that.
 */
export function TechConfigScreen() {
  const { t, locale } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [errorSent, setErrorSent] = useState(false);
  const [licensesShown, setLicensesShown] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ok", health: await fetchHealth() });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, []);
  useEffect(() => {
    if (!isProduction()) void load();
  }, [load]);

  // The app's own git commit, as opposed to the API's: app.config.ts stamped
  // it into the config when this JavaScript was exported or built.
  const appCommit: unknown = Constants.expoConfig?.extra?.commit;
  const appCommitLine =
    typeof appCommit === "string" && appCommit.length > 0
      ? t("tech.app.commit", { commit: appCommit })
      : t("tech.app.noCommit");
  // The native build's runtime (the fingerprint, ADR-004) and the update it
  // runs, by its publish time: an update only reaches a build with the same
  // runtime, so a commit that stops moving here while the API's moves on
  // means this build is behind the fingerprint and needs reinstalling.
  const runtime: unknown = Updates.runtimeVersion;
  const runtimeLine =
    typeof runtime === "string" && runtime.length > 0
      ? t("tech.app.runtime", { runtime: runtime.slice(0, 7) })
      : t("tech.app.noRuntime");
  const updatedAt: unknown = Updates.createdAt;
  const updateLine =
    Updates.isEmbeddedLaunch === true
      ? t("tech.app.embedded")
      : updatedAt instanceof Date && !Number.isNaN(updatedAt.getTime())
        ? t("tech.app.updated", {
            date: formatDate(locale, updatedAt, { dateStyle: "medium", timeStyle: "short" }),
          })
        : null;
  const version: unknown = Constants.expoConfig?.version;
  const versionLine = t("tech.app.version", {
    version: typeof version === "string" && version.length > 0 ? version : "?",
  });

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="items-center gap-4 p-6">
        <View className="w-full max-w-md flex-row items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            accessibilityLabel={t("tech.back")}
            onPress={() => {
              tap();
              router.back();
            }}
          >
            <Icon as={ArrowLeft} />
          </Button>
          <Text variant="h1" accessibilityRole="header">
            {t("tech.title")}
          </Text>
        </View>

        {isProduction() ? (
          <Text className="w-full max-w-md">{t("tech.unavailable")}</Text>
        ) : (
          <>
            <Text variant="muted" className="w-full max-w-md">
              {t("tech.environment", { environment: appEnvironment() })}
            </Text>

            <Card className="w-full max-w-md">
              <View accessibilityLabel={t("tech.api.title")} className="gap-6">
                <CardHeader>
                  <CardTitle>{t("tech.api.title")}</CardTitle>
                  {/* An address has no spaces to wrap at; full width lets it break (#31). */}
                  <CardDescription>{apiBaseUrl()}</CardDescription>
                </CardHeader>
                <CardContent className="gap-3">
                  {state.kind === "loading" && (
                    <View accessibilityLabel={t("tech.api.loading")} className="gap-3">
                      <Text>{t("tech.api.loading")}</Text>
                      <Skeleton className="h-4 w-2/3" />
                    </View>
                  )}
                  {state.kind === "ok" && (
                    <>
                      <Text>{t("tech.api.commit", { commit: state.health.commit })}</Text>
                      <Text variant="muted">
                        {t("tech.api.database", {
                          db: state.health.db,
                          migrations: state.health.migrations,
                        })}
                      </Text>
                    </>
                  )}
                  {state.kind === "error" && (
                    <>
                      {/* The words carry the state; the colour only repeats it. */}
                      <Text className="text-destructive">{t("tech.api.unreachable")}</Text>
                      <Text variant="muted">{state.message}</Text>
                    </>
                  )}
                  <Button
                    variant="outline"
                    accessibilityLabel={t("tech.api.check")}
                    onPress={() => {
                      tap();
                      void load();
                    }}
                  >
                    <Text>{t("tech.api.check")}</Text>
                  </Button>
                </CardContent>
              </View>
            </Card>

            <Card className="w-full max-w-md">
              <View accessibilityLabel={t("tech.app.title")} className="gap-6">
                <CardHeader>
                  <CardTitle>{t("tech.app.title")}</CardTitle>
                  <CardDescription>{appCommitLine}</CardDescription>
                  <CardDescription>{runtimeLine}</CardDescription>
                  {updateLine && <CardDescription>{updateLine}</CardDescription>}
                  <CardDescription>
                    {t("tech.app.channel", { channel: Updates.channel ?? "" })}
                  </CardDescription>
                  <CardDescription>{versionLine}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    variant="ghost"
                    accessibilityRole="link"
                    accessibilityLabel={t("tech.app.releases")}
                    onPress={() => void Linking.openURL(RELEASES_URL)}
                  >
                    <Text className="text-primary underline">{t("tech.app.releases")}</Text>
                    <Icon as={ExternalLink} className="text-primary" size={16} />
                  </Button>
                </CardContent>
              </View>
            </Card>

            {/* Proves error reporting end to end (#11): a real JS error with a stack
                for Sentry to symbolicate. A no-op in a build without a DSN. */}
            <View className="w-full max-w-md gap-2">
              <Button
                variant="outline"
                accessibilityLabel={t("tech.errorTest.send")}
                onPress={() => {
                  Sentry.captureException(new Error("Sentry test from the tech config screen"));
                  setErrorSent(true);
                }}
              >
                <Text>{t("tech.errorTest.send")}</Text>
              </Button>
              {errorSent && <Text variant="muted">{t("tech.errorTest.sent")}</Text>}
            </View>

            {state.kind === "ok" && <SourceOffer source={state.health.source} />}

            {/* The packages this build is made of, with their licences (scripts/licenses.ts). */}
            <View className="w-full max-w-md gap-2">
              <Text variant="small" accessibilityRole="header">
                {t("tech.licenses.title")}
              </Text>
              <Button
                variant="outline"
                accessibilityLabel={
                  licensesShown
                    ? t("tech.licenses.hide")
                    : t("tech.licenses.show", { packages: LICENSES.length })
                }
                onPress={() => {
                  tap();
                  setLicensesShown((shown) => !shown);
                }}
              >
                <Text>
                  {licensesShown
                    ? t("tech.licenses.hide")
                    : t("tech.licenses.show", { packages: LICENSES.length })}
                </Text>
              </Button>
              {licensesShown &&
                LICENSES.map((entry) => (
                  <Text key={`${entry.name}@${entry.version}`} variant="muted">
                    {`${entry.name} ${entry.version} · ${entry.license}`}
                  </Text>
                ))}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
