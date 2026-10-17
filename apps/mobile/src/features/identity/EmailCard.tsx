import { EMAIL_MAX } from "@kuutti/schema";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailed } from "@/components/LoadFailed";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { DEAL_BREAKERS_PATH } from "@/features/profile";
import { ApiError } from "@/lib/api";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { clearEmail, fetchEmail, saveEmail } from "./email-client";
import { useSession } from "./session";

type Notice = "saved" | "invalid" | "failed" | null;

/**
 * The optional e-mail (#148, TD-18) as a card: the honest reason first, the
 * address, save and remove. Never shown to anybody else and never a login;
 * the API keeps it out of every log line. On its own screen in Settings
 * (#287), and as the last of the later screens. While the address is being
 * read it says so, and a read that failed says why, with a way to read it
 * again; nothing for a signed-out device.
 */
export function EmailCard() {
  const { t } = useT();
  const session = useSession();
  const tap = useHapticTap();
  const signedIn = session.status === "signed-in";
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [error, setError] = useState<unknown>(null);
  const [stored, setStored] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const read = useCallback(() => {
    setState("loading");
    fetchEmail().then(
      (email) => {
        if (!mounted.current) return;
        setStored(email);
        setTyped(email ?? "");
        setState("ready");
      },
      (failure: unknown) => {
        if (!mounted.current) return;
        setError(failure);
        setState("unavailable");
      },
    );
  }, []);
  useEffect(() => {
    if (signedIn) read();
  }, [signedIn, read]);

  if (!signedIn) return null;
  if (state === "loading") {
    return (
      <Text variant="muted" accessibilityLiveRegion="polite">
        {t("account.email.loading")}
      </Text>
    );
  }
  if (state === "unavailable") {
    return <LoadFailed headline={t("account.email.loadFailed")} error={error} onRetry={read} />;
  }

  const run = async (call: () => Promise<string | null>) => {
    setBusy(true);
    setNotice(null);
    try {
      const email = await call();
      setStored(email);
      setTyped(email ?? "");
      setNotice("saved");
    } catch (error) {
      setNotice(error instanceof ApiError && error.status === 400 ? "invalid" : "failed");
    } finally {
      setBusy(false);
    }
  };
  const address = typed.trim();

  return (
    <Card className="w-full max-w-md">
      <View accessibilityLabel={t("account.email.title")} className="gap-4">
        <CardHeader>
          <CardTitle>{t("account.email.title")}</CardTitle>
          <CardDescription>{t("account.email.explain")}</CardDescription>
        </CardHeader>
        <CardContent className="gap-3">
          <Input
            accessibilityLabel={t("account.email.label")}
            value={typed}
            maxLength={EMAIL_MAX}
            autoCapitalize="none"
            autoCorrect={false}
            inputMode="email"
            onChangeText={(text) => {
              setNotice(null);
              setTyped(text);
            }}
          />
          {stored !== null && <Text variant="muted">{t("account.email.set")}</Text>}
          {notice && (
            <Text accessibilityLiveRegion="assertive">
              {notice === "saved"
                ? t("account.email.saved")
                : notice === "invalid"
                  ? t("account.email.invalid")
                  : t("account.email.failed")}
            </Text>
          )}
          <Button
            disabled={busy || address.length === 0 || address === stored}
            onPress={() => {
              tap();
              void run(() => saveEmail(address));
            }}
          >
            {t("account.email.save")}
          </Button>
          {stored !== null && (
            <Button
              variant="outline"
              disabled={busy}
              onPress={() => {
                tap();
                void run(() => clearEmail());
              }}
            >
              {t("account.email.clear")}
            </Button>
          )}
        </CardContent>
      </View>
    </Card>
  );
}

/**
 * The e-mail as the last of the later screens (#148): the card, and the way
 * home. It scrolls, so at the largest text every line and every button can
 * still be reached (#217).
 */
export function EmailScreen() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView
        contentContainerClassName="flex-grow items-center gap-6 p-6"
        keyboardShouldPersistTaps="handled"
      >
        <Text variant="h1" accessibilityRole="header">
          {t("profile.later.title")}
        </Text>
        <EmailCard />
        <Text>{t("profile.later.done")}</Text>
        {/* The deal-breakers come after the optional fields (#149): one tap, never required. */}
        <Button
          variant="outline"
          onPress={() => {
            tap();
            router.push(DEAL_BREAKERS_PATH);
          }}
        >
          {t("profile.dealBreakers.open")}
        </Button>
        <Button
          onPress={() => {
            tap();
            router.replace("/");
          }}
        >
          {t("account.email.done")}
        </Button>
      </ScrollView>
    </SafeAreaView>
  );
}
