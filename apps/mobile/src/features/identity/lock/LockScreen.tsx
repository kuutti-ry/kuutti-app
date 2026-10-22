import type { PlainMessageKey } from "@kuutti/i18n";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import type { BiometricAnswer, Biometrics } from "./biometrics";
import { PasscodeField } from "./PasscodeField";

const UNLOCK_WITH: Record<Biometrics, PlainMessageKey> = {
  face: "lock.unlock.face",
  fingerprint: "lock.unlock.fingerprint",
  either: "lock.unlock.biometrics",
};

/** What a passcode try answered: in, or how many tries are left. */
export type PasscodeAnswer = { ok: true } | { ok: false; left: number };

/**
 * The lock over the app (#418, ADR-045): the phone's face or fingerprint when
 * the person chose it, asked at once and again on the button; Kuutti's
 * passcode when one is set; and always the bank, which signs this phone out
 * and turns the lock off. Biometrics are never the only way in. Nothing moves
 * or shakes: a wrong passcode is said in words, aloud on iOS and as a live
 * region on Android.
 */
export function LockScreen({
  biometrics,
  passcode,
  onBiometrics,
  onPasscode,
  onBank,
}: {
  /** The phone's kind when the person chose it and the phone still has it; null otherwise. */
  biometrics: Biometrics | null;
  passcode: boolean;
  onBiometrics: () => Promise<BiometricAnswer>;
  onPasscode: (code: string) => Promise<PasscodeAnswer>;
  onBank: () => void;
}) {
  const { t } = useT();
  const tap = useHapticTap();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Each notice a fresh live region, so Android says a second wrong try too.
  const [said, setSaid] = useState(0);

  const say = (words: string | null) => {
    setNotice(words);
    setSaid((n) => n + 1);
    if (words !== null && Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(words);
  };

  const askBiometrics = async () => {
    setBusy(true);
    try {
      const answer = await onBiometrics();
      say(answer === "failed" ? t("lock.biometrics.failed") : null);
    } finally {
      setBusy(false);
    }
  };

  // Asked once as the lock shows; after that, the button asks again.
  const asked = useRef(false);
  useEffect(() => {
    if (biometrics === null || asked.current) return;
    asked.current = true;
    void askBiometrics();
  });

  // One try at a time. The field stays editable, so the number pad stays up
  // for the next try, and what is typed while one is checked is dropped.
  const checking = useRef(false);
  const tryPasscode = async (typed: string) => {
    if (checking.current) return;
    checking.current = true;
    setBusy(true);
    try {
      const answer = await onPasscode(typed);
      setCode("");
      say(answer.ok ? null : t("lock.passcode.wrong", { left: answer.left }));
    } finally {
      checking.current = false;
      setBusy(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-background">
      {/* The wrong try's words and the bank stay above the number pad, as on a
          settings screen (SettingsPage, #103). */}
      <KeyboardAvoidingView
        className="flex-1"
        behavior="padding"
        enabled={Platform.OS === "android"}
      >
        <ScrollView
          contentContainerClassName="flex-grow items-center justify-center gap-6 p-6"
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          <Text variant="h1" accessibilityRole="header">
            {t("lock.title")}
          </Text>
          <View className="w-full max-w-md gap-4">
            {biometrics !== null && (
              <Button
                disabled={busy}
                onPress={() => {
                  tap();
                  void askBiometrics();
                }}
              >
                {t(UNLOCK_WITH[biometrics])}
              </Button>
            )}
            {passcode && (
              <PasscodeField
                label={t("lock.passcode.label")}
                value={code}
                autoFocus={biometrics === null}
                onChange={(digits) => {
                  if (checking.current) return;
                  setCode(digits);
                  if (digits.length > 0 && notice !== null) setNotice(null);
                }}
                onComplete={(typed) => void tryPasscode(typed)}
              />
            )}
            {notice !== null && (
              <Text key={said} accessibilityLiveRegion="assertive">
                {notice}
              </Text>
            )}
            <Text variant="muted">{t("lock.bank.explain")}</Text>
            <Button
              variant="outline"
              disabled={busy}
              onPress={() => {
                tap();
                onBank();
              }}
            >
              {t("lock.bank")}
            </Button>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
