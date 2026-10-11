import { formatDate, type PlainMessageKey } from "@kuutti/i18n";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Linking, Platform, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { ApiError, apiBaseUrl } from "@/lib/api";
import { useT } from "@/lib/locale";
import { markLoginStarted, takeLoginStarted } from "@/lib/session";
import { useHapticTap } from "@/theme/haptics";
import { useSession } from "./session";

/** What the deep link `kuutti://auth` may carry: a one-time code, or the refusal's code and date. */
export type SignInParams = { code?: string; error?: string; until?: string };

type Phase =
  | { kind: "idle" }
  | { kind: "opening" }
  | { kind: "exchanging" }
  | { kind: "done" }
  | { kind: "error"; code: string; until?: string };

/**
 * The refusals the API can send back through the deep link, each with its
 * own text, plus the app's own. A Map, so a crafted link (`?error=toString`)
 * finds nothing rather than a prototype member.
 */
const REFUSALS: ReadonlyMap<string, PlainMessageKey> = new Map([
  ["auth_code_used", "signIn.error.auth_code_used"],
  ["auth_state_mismatch", "signIn.error.auth_state_mismatch"],
  ["auth_under_18", "signIn.error.auth_under_18"],
  ["auth_banned", "signIn.error.auth_banned"],
  ["auth_suspended", "signIn.error.auth_suspended"],
  ["auth_provider_error", "signIn.error.auth_provider_error"],
  ["auth_cancelled", "signIn.error.auth_cancelled"],
  ["unexpected_link", "signIn.error.unexpected_link"],
]);

/**
 * The bank login's two halves on the phone (#36, rules/mobile.md Auth): the
 * button opens the API's /auth/start in the system browser (never a WebView:
 * the bank's cookies stay out of the app), and the return through the deep
 * link lands here with a one-time code that becomes this device's session.
 * Only a code for a login this device started is exchanged, and never over a
 * session that exists: a link someone else minted is refused (login CSRF).
 * The API's language follows the browser's, which follows the phone.
 */
export function SignInScreen({ code, error, until }: SignInParams) {
  const { t, locale } = useT();
  const session = useSession();
  const router = useRouter();
  const tap = useHapticTap();
  const [phase, setPhase] = useState<Phase>(() =>
    error ? { kind: "error", code: error, until } : { kind: "idle" },
  );
  // A code is exchanged once, however often the screen re-renders with it.
  const exchanged = useRef<string | null>(null);
  const { signIn } = session;

  // A refusal can arrive while this screen is shown: "Try again" opens the
  // browser from here, and the link comes back to the same screen with its
  // answer. The first state alone would go on saying that the bank is open.
  useEffect(() => {
    if (error) setPhase({ kind: "error", code: error, until });
  }, [error, until]);

  const status = session.status;
  useEffect(() => {
    if (!code || status === "loading" || exchanged.current === code) return;
    exchanged.current = code;
    setPhase({ kind: "exchanging" });
    void (async () => {
      const asked = await takeLoginStarted();
      if (!asked || status === "signed-in") {
        setPhase({ kind: "error", code: "unexpected_link" });
        return;
      }
      try {
        await signIn(code);
        setPhase({ kind: "done" });
        router.replace("/");
      } catch (failure: unknown) {
        setPhase({
          kind: "error",
          code: failure instanceof ApiError && failure.code ? failure.code : "generic",
        });
      }
    })();
  }, [code, status, signIn, router]);

  const open = async () => {
    tap();
    setPhase({ kind: "opening" });
    // What the last link said is put away, so that the next one is news even
    // when it says the same: the same refusal twice is two refusals.
    router.setParams({ code: undefined, error: undefined, until: undefined });
    try {
      await markLoginStarted();
      // The bank's chooser in the app's language, which can differ from the
      // phone's and so from the browser's (#55); en-XA asks for English.
      const bankLocale = locale === "fi" || locale === "sv" ? locale : "en";
      await Linking.openURL(
        `${apiBaseUrl()}/auth/start?platform=${Platform.OS}&locale=${bankLocale}`,
      );
    } catch {
      setPhase({ kind: "error", code: "generic" });
    }
  };

  const refusalText = (failure: { code: string; until?: string }): string => {
    if (failure.code === "auth_cooldown") {
      const day = failure.until ? new Date(failure.until) : null;
      return t("signIn.error.auth_cooldown", {
        date: day && !Number.isNaN(day.getTime()) ? formatDate(locale, day) : "",
      });
    }
    return t(REFUSALS.get(failure.code) ?? "signIn.error.generic");
  };

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="flex-grow items-center justify-center gap-4 p-6">
        <Text variant="h1" accessibilityRole="header">
          {t("signIn.title")}
        </Text>
        <Text className="w-full max-w-md text-center">{t("signIn.explain")}</Text>

        {phase.kind === "error" && (
          <Card className="w-full max-w-md">
            {/* The words carry the state; the colour only repeats it. */}
            <View accessibilityLabel={t("signIn.error.title")} className="gap-6">
              <CardHeader>
                <CardTitle className="text-destructive">{t("signIn.error.title")}</CardTitle>
                <CardDescription>{refusalText(phase)}</CardDescription>
              </CardHeader>
            </View>
          </Card>
        )}

        {(phase.kind === "opening" || phase.kind === "exchanging" || phase.kind === "done") && (
          <Card className="w-full max-w-md">
            <CardContent>
              <Text accessibilityLiveRegion="polite">
                {phase.kind === "opening"
                  ? t("signIn.opening")
                  : phase.kind === "exchanging"
                    ? t("signIn.exchanging")
                    : t("signIn.done")}
              </Text>
            </CardContent>
          </Card>
        )}

        {phase.kind !== "exchanging" && phase.kind !== "done" && (
          <Button
            accessibilityLabel={phase.kind === "error" ? t("signIn.tryAgain") : t("signIn.button")}
            className="w-full max-w-md"
            onPress={() => void open()}
          >
            <Text>{phase.kind === "error" ? t("signIn.tryAgain") : t("signIn.button")}</Text>
          </Button>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
