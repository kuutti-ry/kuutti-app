import * as Sentry from "@sentry/react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { savePushToken } from "./client";

/**
 * Whether this phone lets Kuutti notify it (ADR-055 §9). "unavailable" where
 * no push can reach: the web preview, or a phone whose answer could not be
 * read.
 */
export type PhonePermission = "allowed" | "denied" | "undetermined" | "unavailable";

/** Android's one channel, the one app.json's `defaultChannel` names. */
const CHANNEL = "default";

const onPhone = () => Platform.OS === "ios" || Platform.OS === "android";

/**
 * The phone's answer in the app's words. iOS says it in its own status, where
 * a provisional or an ephemeral grant shows the pushes quietly and counts as
 * allowed; an iOS answer without that part is one that could not be read.
 * Android says it in the root status.
 */
export function permissionOf(answer: Notifications.NotificationPermissionsStatus): PhonePermission {
  if (Platform.OS === "ios") {
    switch (answer.ios?.status) {
      case Notifications.IosAuthorizationStatus.AUTHORIZED:
      case Notifications.IosAuthorizationStatus.PROVISIONAL:
      case Notifications.IosAuthorizationStatus.EPHEMERAL:
        return "allowed";
      case Notifications.IosAuthorizationStatus.DENIED:
        return "denied";
      case Notifications.IosAuthorizationStatus.NOT_DETERMINED:
        return "undetermined";
      default:
        return "unavailable";
    }
  }
  if (answer.granted) return "allowed";
  // expo's PermissionStatus is a string enum, compared here by its value.
  return (answer.status as string) === "undetermined" ? "undetermined" : "denied";
}

/** The phone's permission as it stands, asking nothing. */
export async function readPermission(): Promise<PhonePermission> {
  if (!onPhone()) return "unavailable";
  try {
    return permissionOf(await Notifications.getPermissionsAsync());
  } catch (error) {
    // Reported with the error alone; the screens say that the phone cannot be told.
    Sentry.captureException(error);
    return "unavailable";
  }
}

/**
 * Android's channel, in the app's language: made before the phone is asked,
 * since Android 13 shows no question without one, and again at every
 * registration, which renames it when the language changed and makes it on
 * an Android that never asks. No badge on the launcher's icon (ADR-055 §1).
 */
async function makeChannel(name: string): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(CHANNEL, {
    name,
    importance: Notifications.AndroidImportance.DEFAULT,
    showBadge: false,
  });
}

/**
 * The phone's own question (ADR-055 §9): to show a push and make its sound,
 * never to put a count on the icon. `channel` is the channel's name. A
 * question that fails is reported and leaves the phone unable to be told.
 */
export async function askPermission(channel: string): Promise<PhonePermission> {
  if (!onPhone()) return "unavailable";
  try {
    await makeChannel(channel);
    return permissionOf(
      await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowSound: true, allowBadge: false },
      }),
    );
  } catch (error) {
    Sentry.captureException(error);
    return "unavailable";
  }
}

type Registration = {
  /** The app's language, which the API words the pushes in. */
  locale: string;
  /** Android's channel's name, in that language. */
  channel: string;
  /**
   * The device token the phone has just handed over (addPushTokenListener):
   * Expo's is made from it, since asking the phone for it again would hand
   * it over again, and the listener would be called without end.
   */
  device?: Notifications.DevicePushToken;
};

let registering: Promise<void> = Promise.resolve();

/**
 * Hands this phone's Expo push token to the API for the signed-in session
 * (ADR-055 §2), only while the phone allows notifications, and nothing but
 * the token and the platform. One at a time, in the order asked, so that the
 * language of the last one is the language the API keeps. A failure is not
 * the person's to see, since the next start registers again; it is reported,
 * the error alone.
 */
export function registerPush(registration: Registration): Promise<void> {
  registering = registering.then(() => register(registration));
  return registering;
}

async function register({ locale, channel, device }: Registration): Promise<void> {
  const platform = Platform.OS;
  if (platform !== "ios" && platform !== "android") return;
  if ((await readPermission()) !== "allowed") return;
  try {
    await makeChannel(channel);
    const { data: token } = await Notifications.getExpoPushTokenAsync({
      projectId: Constants.expoConfig?.extra?.eas?.projectId,
      devicePushToken: device,
    });
    await savePushToken({ token, platform }, locale);
  } catch (error) {
    Sentry.captureException(error);
  }
}
