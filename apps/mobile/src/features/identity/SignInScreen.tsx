import { formatDate, type PlainMessageKey } from "@kuutti/i18n";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { AppState, Linking, Platform, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { ApiError, apiBaseUrl } from "@/lib/api";
import { useT } from "@/lib/locale";
import { markLoginStarted, takeLoginStarted } from "@/lib/session";
import { useHapticTap } from "@/theme/haptics";
import {
  agreedOnThisPhone,
  bindAgreements,
  dropAgreements,
  dropUnboundAgreements,
  heldAgreements,
  holdAgreements,
  recordAgreements,
  takeAgreements,
} from "./agreements";
import { BeforeSignIn } from "./BeforeSignIn";
import { useSession } from "./session";
import { challengeOf, newVerifier } from "./verifier";

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
 * finds nothing rather than a prototype member. The sign-in's rate limit
 * refuses a start through the link and an exchange with a 429 (ADR-026 §4):
 * one text for both, since both ask for the same wait.
 */
const REFUSALS: ReadonlyMap<string, PlainMessageKey> = new Map([
  ["auth_code_used", "signIn.error.auth_code_used"],
  ["auth_state_mismatch", "signIn.error.auth_state_mismatch"],
  ["auth_under_18", "signIn.error.auth_under_18"],
  ["auth_banned", "signIn.error.auth_banned"],
  ["auth_suspended", "signIn.error.auth_suspended"],
  ["auth_provider_error", "signIn.error.auth_provider_error"],
  ["auth_cancelled", "signIn.error.auth_cancelled"],
  ["auth_rate_limited", "signIn.error.auth_rate_limited"],
  ["rate_limited", "signIn.error.auth_rate_limited"],
  ["auth_unavailable", "signIn.unavailable"],
  ["unexpected_link", "signIn.error.unexpected_link"],
]);

/**
 * The bank login's two halves on the phone (#36, rules/mobile.md Auth): the
 * button opens the API's /auth/start in the system browser (never a WebView:
 * the bank's cookies stay out of the app), and the return through the deep
 * link lands here with a one-time code that becomes this device's session.
 * Only a code for a login this device started is exchanged, and never over a
 * session that exists: a link someone else minted is refused (login CSRF).
 * The code is bound to this phone too: the start carries the SHA-256 of a
 * verifier kept with the mark, and the exchange sends the verifier, so a code
 * another app reads off the link is refused without it (ADR-027).
 * The API's language follows the browser's, which follows the phone.
 * The bank is reached only past the terms and the privacy summary (#418,
 * ADR-010 §15): until this phone has recorded the versions it carries, the
 * screens before the bank stand where the button would, and their answers
 * become the account's rows right after the exchange.
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
  // Whether the bank may be reached: answers held from this run, or the
  // versions this phone recorded before; null while the phone is asked.
  const [agreed, setAgreed] = useState<boolean | null>(() =>
    heldAgreements() !== null ? true : null,
  );
  useEffect(() => {
    if (agreed !== null) return;
    let live = true;
    void agreedOnThisPhone().then((yes) => {
      if (live) setAgreed(yes);
    });
    return () => {
      live = false;
    };
  }, [agreed]);
  // Answers not yet carried to the bank end when the app leaves the screen.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "background" && dropUnboundAgreements()) setAgreed(null);
    });
    return () => subscription.remove();
  }, []);

  // A refusal can arrive while this screen is shown: "Try again" opens the
  // browser from here, and the link comes back to the same screen with its
  // answer. The first state alone would go on saying that the bank is open.
  // A refusal also ends the answers held for that attempt (#418): the phone
  // is asked again whether it has recorded them.
  useEffect(() => {
    if (!error) return;
    setPhase({ kind: "error", code: error, until });
    dropAgreements();
    setAgreed(null);
  }, [error, until]);

  const status = session.status;
  useEffect(() => {
    if (!code || status === "loading" || exchanged.current === code) return;
    exchanged.current = code;
    setPhase({ kind: "exchanging" });
    void (async () => {
      const verifier = await takeLoginStarted();
      if (!verifier || status === "signed-in") {
        setPhase({ kind: "error", code: "unexpected_link" });
        return;
      }
      try {
        await signIn(code, verifier);
        // Before the status is read: onboarding then finds them given.
        const agreements = takeAgreements(challengeOf(verifier));
        if (agreements) await recordAgreements(agreements);
        setPhase({ kind: "done" });
        router.replace("/");
      } catch (failure: unknown) {
        setPhase({
          kind: "error",
          code: failure instanceof ApiError && failure.code ? failure.code : "generic",
        });
        dropAgreements();
        setAgreed(null);
      }
    })();
  }, [code, status, signIn, router]);

  const open = async () => {
    tap();
    // Never past the screens before the bank: the answers of this run, or
    // the versions this phone recorded, or back to the screens.
    if (heldAgreements() === null && !(await agreedOnThisPhone())) {
      setAgreed(false);
      setPhase({ kind: "idle" });
      return;
    }
    setPhase({ kind: "opening" });
    // What the last link said is put away, so that the next one is news even
    // when it says the same: the same refusal twice is two refusals.
    router.setParams({ code: undefined, error: undefined, until: undefined });
    try {
      // A verifier for this attempt alone: a second tap replaces the first's,
      // and a code from the first's browser tab is refused (ADR-027).
      const verifier = newVerifier();
      const now = Date.now();
      // The answers go with this attempt; carried into another already, they
      // are asked again, and so is the bank's button on a phone that recorded them.
      if (heldAgreements() !== null && !bindAgreements(challengeOf(verifier), now)) {
        setAgreed(null);
        setPhase({ kind: "idle" });
        return;
      }
      await markLoginStarted(verifier, now);
      // The bank's chooser in the app's language, which can differ from the
      // phone's and so from the browser's (#55); en-XA asks for English.
      const bankLocale = locale === "fi" || locale === "sv" ? locale : "en";
      await Linking.openURL(
        `${apiBaseUrl()}/auth/start?platform=${Platform.OS}&locale=${bankLocale}&code_challenge=${challengeOf(verifier)}`,
      );
    } catch {
      setPhase({ kind: "error", code: "generic" });
    }
  };

  const refusalText = (failure: { code: string; until?: string }): string => {
    const day = failure.until ? new Date(failure.until) : null;
    const valid = day !== null && !Number.isNaN(day.getTime());
    if (failure.code === "auth_cooldown") {
      return t("signIn.error.auth_cooldown", { date: valid ? formatDate(locale, day) : "" });
    }
    // A suspension ends at the start of a day in Finland (ADR-024 §5): that
    // day, read in Finland's zone, so a phone abroad names the same one.
    // Without a day the plain sentence, as an older API sends it.
    if (failure.code === "auth_suspended" && valid) {
      return t("signIn.error.auth_suspended_until", {
        date: formatDate(locale, day, { timeZone: "Europe/Helsinki" }),
      });
    }
    return t(REFUSALS.get(failure.code) ?? "signIn.error.generic");
  };

  if (Platform.OS !== "web" && agreed === false && phase.kind === "idle") {
    return (
      <BeforeSignIn
        onAgreed={(agreements) => {
          holdAgreements(agreements);
          setAgreed(true);
        }}
      />
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="flex-grow items-center justify-center gap-4 p-6">
        <Text variant="h1" accessibilityRole="header">
          {t("signIn.title")}
        </Text>
        <Text className="w-full max-w-md text-center">{t("signIn.explain")}</Text>

        {/* Right after a break began on this device (#170): why the sign-in is back, and that nothing is lost. */}
        {/* Right after the lock signed this phone out (#418): why, and that the lock is off now. */}
        {session.status === "signed-out" && session.notice === "lock" && (
          <Card className="w-full max-w-md">
            <View accessibilityLabel={t("signIn.lock.title")} className="gap-6">
              <CardHeader>
                <CardTitle>{t("signIn.lock.title")}</CardTitle>
                <CardDescription>{t("signIn.lock.body")}</CardDescription>
              </CardHeader>
            </View>
          </Card>
        )}

        {session.status === "signed-out" && session.notice === "paused" && (
          <Card className="w-full max-w-md">
            <View accessibilityLabel={t("signIn.paused.title")} className="gap-6">
              <CardHeader>
                <CardTitle>{t("signIn.paused.title")}</CardTitle>
                <CardDescription>{t("signIn.paused.body")}</CardDescription>
              </CardHeader>
            </View>
          </Card>
        )}

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

        {/* The bank sends the browser back to the app's scheme, which a web
            page does not have (AuthPlatform): no button that cannot work. */}
        {Platform.OS === "web" && (
          <Text className="w-full max-w-md text-center">{t("signIn.unavailable")}</Text>
        )}

        {Platform.OS !== "web" &&
          agreed !== null &&
          phase.kind !== "exchanging" &&
          phase.kind !== "done" && (
            <Button
              accessibilityLabel={
                phase.kind === "error" ? t("signIn.tryAgain") : t("signIn.button")
              }
              className="w-full max-w-md"
              // Never past the screens before the bank: a refusal shown on a
              // phone that has not answered them goes back to them first.
              onPress={() => (agreed ? void open() : setPhase({ kind: "idle" }))}
            >
              <Text>{phase.kind === "error" ? t("signIn.tryAgain") : t("signIn.button")}</Text>
            </Button>
          )}
      </ScrollView>
    </SafeAreaView>
  );
}
