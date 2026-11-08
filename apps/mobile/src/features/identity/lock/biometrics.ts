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

/** What the phone answers: a way in, none, or an iPhone keeping Face ID from Kuutti. */
export type PhoneBiometrics = Biometrics | "denied" | null;

/**
 * What this phone can open the lock with, or null when nothing is enrolled
 * (#418). On Android "enrolled" counts the weak class too, where some phones'
 * face unlock is, as the prompt below accepts it (the maintainer's proposal 3).
 * On Android 16 it is null during the phone's pause too: the phone answers
 * with its pause's own code, which the module reads as nothing enrolled, and
 * the lock keeps the kind it knew while its last ask answered the pause (#499).
 *
 * "denied" is iOS's biometryNotAvailable, which the module reads as no
 * hardware (#505). Every iPhone that runs Kuutti has Face ID or Touch ID, so
 * it means the phone is not letting Kuutti use them: Don't Allow at iOS's
 * question, Kuutti's Face ID switch off in the phone's settings, or now and
 * then neither. The kind says nothing here, as biometryType is reported to
 * read none after a refusal (ADR-045 §5).
 *
 * shortcut: on Android the kind is the hardware the phone declares (the
 * module reads the package manager's features), not what is enrolled or what
 * the prompt takes. A face that only unlocks the phone, as the Pixel 7's,
 * still makes it "either", whose button then names a face the prompt will
 * not take; the "either" refusals say "or" and claim neither (#464).
 * Android 12's BiometricManager.Strings, behind a native module, lifts it.
 *
 * shortcut: a Touch ID sensor that has failed answers as "denied" does, and
 * the words then name Face ID. The module does not tell them apart; a native
 * read of biometryNotAvailable's own reason would, if iOS ever gives one.
 */
export async function biometricsOnThisPhone(): Promise<PhoneBiometrics> {
  if (Platform.OS === "web") return null;
  try {
    if (!(await hasHardwareAsync())) return Platform.OS === "ios" ? "denied" : null;
    if (!(await isEnrolledAsync())) return null;
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

export type BiometricAnswer = "ok" | "cancelled" | "failed" | "lockout" | "denied";

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
 *
 * "denied" is iOS's biometryNotAvailable again, as an ask answers it: Don't
 * Allow at the question iOS shows before the first prompt, and every ask after
 * it. Android's not_available is a sensor that cannot run, a plain failure.
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
    if (result.error === "not_available" && Platform.OS === "ios") return "denied";
    return CANCELS.has(result.error) ? "cancelled" : "failed";
  } catch {
    return "failed";
  }
}
