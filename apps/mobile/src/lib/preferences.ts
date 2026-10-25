import * as Sentry from "@sentry/react-native";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/**
 * Small, non-secret settings that survive a restart: the language override
 * (#13), the theme and the high-contrast choice (#143), the photo tips said
 * for the current main photo (#297), the photo descriptions setting and
 * whether its one-time hint was seen (#296; both stay on the device, never
 * sent anywhere, since whether a person uses a screen reader is theirs
 * alone), the versions of the terms and the privacy summary this phone
 * recorded after a bank login and whether the app's lock was offered here
 * (#418), and whether the home screen's offer of notifications was answered
 * here (#102, ADR-055 §9). expo-secure-store is already in the binary, so no storage module
 * is added for a few strings; the web preview uses localStorage. Session
 * tokens and the lock itself do not go through here (rules/mobile.md).
 */
export type PreferenceKey =
  | "locale"
  | "scheme"
  | "highContrast"
  | "photoTipsSeen"
  | "photoDescriptions"
  | "photoDescriptionsHintSeen"
  | "decisionButtons"
  | "agreedVersions"
  | "lockOffered"
  | "pushAsked";

const storageKey = (key: PreferenceKey): string => `kuutti.preference.${key}`;

export async function readPreference(key: PreferenceKey): Promise<string | null> {
  try {
    if (Platform.OS === "web") return globalThis.localStorage?.getItem(storageKey(key)) ?? null;
    return await SecureStore.getItemAsync(storageKey(key));
  } catch (error) {
    // A preference that cannot be read is a preference that was never set.
    // Reported with the error only: neither the key's value nor anything stored.
    Sentry.captureException(error);
    return null;
  }
}

export async function writePreference(key: PreferenceKey, value: string | null): Promise<void> {
  try {
    if (Platform.OS === "web") {
      if (value === null) globalThis.localStorage?.removeItem(storageKey(key));
      else globalThis.localStorage?.setItem(storageKey(key), value);
    } else if (value === null) {
      await SecureStore.deleteItemAsync(storageKey(key));
    } else {
      await SecureStore.setItemAsync(storageKey(key), value);
    }
  } catch (error) {
    // The choice still holds for this session; it just will not survive a restart.
    Sentry.captureException(error);
  }
}
