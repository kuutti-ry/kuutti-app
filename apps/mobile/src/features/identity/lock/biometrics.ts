import {
  AuthenticationType,
  authenticateAsync,
  hasHardwareAsync,
  isEnrolledAsync,
  supportedAuthenticationTypesAsync,
} from "expo-local-authentication";
import { Platform } from "react-native";

/** Which of the phone's own ways in it offers, for the button's words. */
export type Biometrics = "face" | "fingerprint" | "either";

/**
 * What this phone can open the lock with, or null when nothing is enrolled
 * (#418). On Android "enrolled" counts the weak class too, where some phones'
 * face unlock is, as the prompt below accepts it (the maintainer's proposal 3).
 *
 * shortcut: on Android the kind is the hardware the phone declares (the
 * module reads the package manager's features), not what is enrolled or what
 * the prompt takes. A face that only unlocks the phone, as the Pixel 7's,
 * still makes it "either", whose button then names a face the prompt will
 * not take; the "either" refusals say "or" and claim neither (#464).
 * Android 12's BiometricManager.Strings, behind a native module, lifts it.
 */
export async function biometricsOnThisPhone(): Promise<Biometrics | null> {
  if (Platform.OS === "web") return null;
  try {
    if (!(await hasHardwareAsync()) || !(await isEnrolledAsync())) return null;
    const types = await supportedAuthenticationTypesAsync();
    const face = types.includes(AuthenticationType.FACIAL_RECOGNITION);
    const fingerprint = types.includes(AuthenticationType.FINGERPRINT);
    if (face && !fingerprint) return "face";
    if (fingerprint && !face) return "fingerprint";
    return "either";
  } catch {
    return null;
  }
}

export type BiometricAnswer = "ok" | "cancelled" | "failed" | "lockout";

/** The person or the system put the prompt away: not a failure to say anything about. */
const CANCELS = new Set(["user_cancel", "system_cancel", "app_cancel"]);

/**
 * The phone's own prompt, with no fallback to the phone's code (ADR-045 §5,
 * the maintainer's proposal 2): somebody who knows that code, often a
 * partner, would open Kuutti with it. iOS's "Enter Password" is hidden, as
 * the lock screen offers Kuutti's passcode and the bank itself. Weak
 * biometrics count, which is enough for a lock that guards the screens.
 *
 * "lockout" is the phone's pause after too many tries: the try that brings
 * it ends the prompt, and every ask during it answers at once with no prompt,
 * so a try again would do nothing and it is told apart (#464). Android's
 * 30 seconds and its pause until the phone's own code come as the one code,
 * and so does iOS's, which lasts until that code.
 */
export async function askBiometrics(words: {
  prompt: string;
  cancel: string;
}): Promise<BiometricAnswer> {
  try {
    const result = await authenticateAsync({
      promptMessage: words.prompt,
      cancelLabel: words.cancel,
      disableDeviceFallback: true,
      fallbackLabel: "",
      biometricsSecurityLevel: "weak",
    });
    if (result.success) return "ok";
    if (result.error === "lockout") return "lockout";
    return CANCELS.has(result.error) ? "cancelled" : "failed";
  } catch {
    return "failed";
  }
}
