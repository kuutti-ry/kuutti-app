import * as Sentry from "@sentry/react-native";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/**
 * Small, non-secret settings that survive a restart: the language override
 * (#13), the theme and the high-contrast choice (#143). expo-secure-store is
 * already in the binary, so no storage module is added for three strings; the
 * web preview uses localStorage. Session tokens do not go through here
 * (rules/mobile.md).
 */
export type PreferenceKey = "locale" | "scheme" | "highContrast";

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
