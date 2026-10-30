import type { PlainMessageKey } from "@kuutti/i18n";
import { useEffect, useState } from "react";
import { AccessibilityInfo, AppState, Platform, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { GRACE_MINUTES, PasscodeField, useLock } from "@/features/identity";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { Choice } from "./Choice";

/** Said aloud on iOS; Android's live region below says it already. */
function announce(words: string) {
  if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(words);
}

/** Why the face or fingerprint was not turned on: not confirmed, or paused by the phone (#464). */
const REFUSED: Record<"failed" | "lockout", PlainMessageKey> = {
  failed: "lock.settings.biometricsFailed",
  lockout: "lock.settings.biometricsLockout",
};

/**
 * A new passcode, typed twice (#418): the sixth digit of the first moves on
 * to the second; two that differ start again, said in words.
 */
function PasscodeSetup({
  onDone,
  onCancel,
}: {
  onDone: (code: string) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [first, setFirst] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [mismatch, setMismatch] = useState(false);
  return (
    <View className="gap-4">
      <PasscodeField
        // A field of its own for each entry, so the second starts empty and focused.
        key={first === null ? "choose" : "repeat"}
        label={first === null ? t("lock.passcode.choose") : t("lock.passcode.repeat")}
        value={typed}
        autoFocus
        onChange={setTyped}
        onComplete={(code) => {
          setTyped("");
          if (first === null) {
            setFirst(code);
            setMismatch(false);
          } else if (code === first) {
            onDone(code);
          } else {
            setFirst(null);
            setMismatch(true);
            announce(t("lock.passcode.mismatch"));
          }
        }}
      />
      {mismatch && <Text accessibilityLiveRegion="assertive">{t("lock.passcode.mismatch")}</Text>}
      <Button variant="outline" onPress={onCancel}>
        {t("lock.passcode.cancel")}
      </Button>
    </View>
  );
}

/**
 * The app's lock as the person sets it (#418, ADR-045), in Settings and in
 * its one offer: the phone's face or fingerprint, which must answer once to
 * be turned on; Kuutti's own passcode, set, changed or removed; and while
 * either is on, how long the app may be in the background before it locks
 * again. Nothing here reaches the API.
 */
export function LockControls() {
  const { t } = useT();
  const tap = useHapticTap();
  const lock = useLock();
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<"failed" | "lockout" | null>(null);
  const biometricsOn = lock.settings?.biometrics ?? false;
  // What the phone has now: a face or finger may have been set up or removed
  // since the app started, or in the phone's settings while this row
  // waited, which the lock asks about on return only while it is on (#464).
  // Back from the background only: iOS's Face ID prompt and its question
  // whether Kuutti may use Face ID pass through "inactive" alone, and a
  // refusal there would read as a phone without any.
  const { recheck } = lock;
  useEffect(() => {
    void recheck();
    let away = false;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "background") away = true;
      if (next === "active" && away) {
        away = false;
        void recheck();
      }
    });
    return () => subscription.remove();
  }, [recheck]);

  const toggleBiometrics = async (wanted: boolean) => {
    tap();
    setBusy(true);
    setRefused(null);
    try {
      const answer = await lock.setBiometrics(wanted);
      if (answer !== "ok") {
        setRefused(answer);
        announce(t(REFUSED[answer]));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="gap-6">
      <Text>{t("lock.settings.explain")}</Text>
      {lock.biometrics === null && (
        <Text variant="muted">{t("lock.settings.biometricsMissing")}</Text>
      )}
      {/* Also while the phone no longer has any, if the lock still says so: it can then be turned off. */}
      {((lock.biometrics !== null && lock.biometrics !== undefined) || biometricsOn) && (
        <View className="gap-2">
          <View className="flex-row items-center justify-between gap-4">
            <Label
              nativeID="lock-biometrics-label"
              disabled={busy}
              onPress={() => void toggleBiometrics(!biometricsOn)}
            >
              {t("lock.settings.biometrics")}
            </Label>
            <Switch
              accessibilityLabel={t("lock.settings.biometrics")}
              checked={biometricsOn}
              disabled={busy}
              onCheckedChange={(wanted) => void toggleBiometrics(wanted)}
            />
          </View>
          {refused !== null && (
            <Text accessibilityLiveRegion="assertive">{t(REFUSED[refused])}</Text>
          )}
        </View>
      )}
      {choosing ? (
        <PasscodeSetup
          onCancel={() => {
            tap();
            setChoosing(false);
          }}
          onDone={(code) => {
            void lock.setPasscode(code).then(() => {
              setChoosing(false);
              announce(t("lock.settings.passcodeSet"));
            });
          }}
        />
      ) : lock.settings?.passcode ? (
        <View className="gap-2">
          <Text accessibilityLiveRegion="polite">{t("lock.settings.passcodeSet")}</Text>
          <Button
            variant="outline"
            onPress={() => {
              tap();
              setChoosing(true);
            }}
          >
            {t("lock.settings.changePasscode")}
          </Button>
          <Button
            variant="outline"
            onPress={() => {
              tap();
              void lock.removePasscode();
            }}
          >
            {t("lock.settings.removePasscode")}
          </Button>
        </View>
      ) : (
        <Button
          onPress={() => {
            tap();
            setChoosing(true);
          }}
        >
          {t("lock.settings.setPasscode")}
        </Button>
      )}
      {lock.settings !== null && (
        <View className="gap-2">
          <Text variant="small">{t("lock.settings.grace")}</Text>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={t("lock.settings.grace")}
            className="flex-row flex-wrap gap-2"
          >
            {GRACE_MINUTES.map((minutes) => (
              <Choice
                key={minutes}
                label={
                  minutes === 0
                    ? t("lock.settings.graceNow")
                    : t("lock.settings.graceMinutes", { minutes })
                }
                chosen={lock.settings?.graceMinutes === minutes}
                onPress={() => void lock.setGrace(minutes)}
              />
            ))}
          </View>
          <Text variant="muted">{t("lock.settings.always")}</Text>
        </View>
      )}
    </View>
  );
}
