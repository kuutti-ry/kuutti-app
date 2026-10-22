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
 * (#418). On Android "enrolled" counts the weak class too, where many phones'
 * face unlock is, as the prompt below accepts it (the maintainer's proposal 3).
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

export type BiometricAnswer = "ok" | "cancelled" | "failed";

/** The person or the system put the prompt away: not a failure to say anything about. */
const CANCELS = new Set(["user_cancel", "system_cancel", "app_cancel"]);

/**
 * The phone's own prompt, with no fallback to the phone's code (ADR-045 §5,
 * the maintainer's proposal 2): somebody who knows that code, often a
 * partner, would open Kuutti with it. iOS's "Enter Password" is hidden, as
 * the lock screen offers Kuutti's passcode and the bank itself. Weak
 * biometrics count, which is enough for a lock that guards the screens.
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
    return CANCELS.has(result.error) ? "cancelled" : "failed";
  } catch {
    return "failed";
  }
}
