import { PushData } from "@kuutti/schema";
import * as Sentry from "@sentry/react-native";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import { useLock, useSession } from "@/features/identity";
import { useT } from "@/lib/locale";
import { registerPush } from "./phone";

/** A push that arrives while the app is in front: seen, never heard, never counted (ADR-055 §9). */
const IN_FRONT: Notifications.NotificationBehavior = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

/**
 * The push on this phone (#102, ADR-055 §2, §9), mounted once in the root
 * layout under the session and the lock. Nothing at all on the web target.
 */
export function PushNotifications() {
  return Platform.OS === "web" ? null : <OnThePhone />;
}

/**
 * While signed in, the token is registered at every start (registerPush
 * itself skips a phone that does not allow notifications), whenever the
 * phone hands over a new one, whenever the app's language changes, since
 * the API words the pushes in it, and whenever the app comes back to the
 * front, since the person may have allowed notifications in the phone's
 * settings meanwhile, or the start found no network (registerPush sends
 * nothing when nothing changed). A tap on a push opens what it is about,
 * which is all it says: the conversations for a message or a match, or
 * today's round. It waits while the lock holds the screens and opens once
 * they are unlocked; a tap that came while signed out, or whose lock was
 * left through the bank, is let go. Either way it is cleared, so it opens
 * nothing twice. A sign-out clears the phone's list of Kuutti's pushes.
 */
function OnThePhone() {
  const { t, locale } = useT();
  const session = useSession();
  const { holding } = useLock();
  const router = useRouter();
  const channel = t("push.channel");
  const sessionId = session.status === "signed-in" ? session.sessionId : null;

  useEffect(() => {
    Notifications.setNotificationHandler({ handleNotification: async () => IN_FRONT });
  }, []);

  const signedIn = useRef<string | null>(null);
  useEffect(() => {
    const before = signedIn.current;
    signedIn.current = sessionId;
    if (before === null || sessionId !== null) return;
    // A sign-out clears the pushes still in the phone's list, so that the next
    // person to sign in cannot tap the previous one's. Reported, the error alone.
    Notifications.dismissAllNotificationsAsync().catch((error: unknown) =>
      Sentry.captureException(error),
    );
  }, [sessionId]);

  useEffect(() => {
    if (sessionId === null) return;
    void registerPush({ locale, channel });
    const subscriptions = [
      Notifications.addPushTokenListener((device) => {
        void registerPush({ locale, channel, device });
      }),
      AppState.addEventListener("change", (next) => {
        if (next === "active") void registerPush({ locale, channel });
      }),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, [sessionId, locale, channel]);

  const response = Notifications.useLastNotificationResponse();
  const { status } = session;
  useEffect(() => {
    // At a cold start the session is still being read, and a screen opened
    // under the lock would run before anybody unlocked it (the round marked
    // opened, its photos fetched): the tap waits for both.
    if (!response || status === "loading" || holding) return;
    Notifications.clearLastNotificationResponse();
    if (status !== "signed-in") return;
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const data = PushData.safeParse(response.notification.request.content.data);
    if (!data.success) return;
    router.push(data.data.kind === "round" ? "/round" : "/chats");
  }, [response, status, holding, router]);

  return null;
}
