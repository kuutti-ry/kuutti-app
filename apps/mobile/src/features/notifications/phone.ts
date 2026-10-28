import * as Sentry from "@sentry/react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { currentSession } from "@/lib/session";
import { savePushToken } from "./client";

/**
 * Whether this phone lets Kuutti notify it (ADR-055 §9). "unavailable" where
 * no push can reach: the web preview, or a phone whose answer could not be
 * read.
 */
export type PhonePermission = "allowed" | "denied" | "undetermined" | "unavailable";

/** Android's one channel, the one app.json's `defaultChannel` names. */
const CHANNEL = "default";

/** Whether push can reach this device at all: never on the web target. */
export const onPhone = () => Platform.OS === "ios" || Platform.OS === "android";

/**
 * The phone's answer in the app's words. iOS says it in its own status, where
 * a provisional or an ephemeral grant shows the pushes quietly and counts as
 * allowed; an iOS answer without that part is one that could not be read.
 * Android says it in `granted` and `canAskAgain`, not in the root status.
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
  // From Android 13 notifications are off until the phone says yes, and
  // expo-notifications' root status says denied while they are off, a phone
  // never asked included (NotificationPermissionsModule.kt). canAskAgain is
  // false once the phone has refused for good, and before Android 13 for
  // notifications turned off, which no question turns on.
  // shortcut: a phone refused once may be asked once more, so it reads as never
  // asked and is offered the question again; telling the two apart needs the
  // app to remember that it asked, which expo knows but does not say here.
  return answer.canAskAgain ? "undetermined" : "denied";
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
 * The last registration the API took. On iOS a token fetched hands the token
 * to the token listener again, which would register it a second time; one
 * identical to this is not sent. Kept per session, since a new sign-in on the
 * same phone registers the same token and language for its own session, and
 * only once the API has taken it, so a refused one is sent again next time.
 */
let sent: { sessionId: string; token: string; locale: string } | null = null;
/** Whether the last registration that reached for a token failed: what a return to the front owes. */
let failed = false;

/**
 * Hands this phone's Expo push token to the API for the signed-in session
 * (ADR-055 §2), only while the phone allows notifications, and nothing but
 * the token and the platform. One at a time, in the order asked, so that the
 * language of the last one is the language the API keeps, and never after a
 * sign-out, however long it waited its turn. A failure is not
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
    // Asked while signed in: a sign-out while it waited its turn fetches no
    // token, and one while Expo made it sends nothing.
    const sessionId = currentSession()?.sessionId;
    if (sessionId === undefined) return;
    const { data: token } = await Notifications.getExpoPushTokenAsync({
      projectId: Constants.expoConfig?.extra?.eas?.projectId,
      devicePushToken: device,
    });
    if (currentSession()?.sessionId !== sessionId) return;
    failed = false;
    if (sent?.sessionId === sessionId && sent.token === token && sent.locale === locale) return;
    await savePushToken({ token, platform }, locale);
    sent = { sessionId, token, locale };
  } catch (error) {
    failed = true;
    Sentry.captureException(error);
  }
}

/**
 * A registration on the app's return to the front (#102, ADR-055 §9), only
 * when one is owed: nothing registered yet for this session (the phone may
 * have just been allowed in its own settings), another language, or a last
 * try that failed (a start with no network). Otherwise nothing at all, since
 * fetching the token tells Expo of every return to the app.
 */
export function registerOnReturn(registration: Registration): Promise<void> {
  registering = registering.then(() => {
    const owed =
      failed ||
      sent === null ||
      sent.sessionId !== currentSession()?.sessionId ||
      sent.locale !== registration.locale;
    return owed ? register(registration) : undefined;
  });
  return registering;
}

/**
 * Has Apple or Google drop this phone's device token (#102), after a
 * sign-out whose logout the API never took: the server's session lives on
 * until it expires, and with it the token, which would bring the previous
 * person's pushes here. Expo's next ticket or receipt for it then says
 * DeviceNotRegistered and the API deletes the row (ADR-055 §8); the next
 * sign-in fetches a token again. In turn with the registrations, so that
 * one on its way registers nothing after it and the next sign-in's comes
 * after it. Nothing on the web target; a failure is reported, the error
 * alone, and never thrown.
 */
export function unregisterPush(): Promise<void> {
  registering = registering.then(unregister);
  return registering;
}

async function unregister(): Promise<void> {
  if (!onPhone()) return;
  try {
    await Notifications.unregisterForNotificationsAsync();
  } catch (error) {
    Sentry.captureException(error);
  }
}
