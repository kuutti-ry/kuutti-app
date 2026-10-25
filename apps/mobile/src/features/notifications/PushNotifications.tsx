import { PushData } from "@kuutti/schema";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import { useSession } from "@/features/identity";
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
 * phone hands over a new one, and whenever the app's language changes, since
 * the API words the pushes in it. A tap on a push opens what it is about:
 * its conversation, or today's round, under the lock if the lock is on; a tap
 * that came while signed out is let go. Either way it is cleared, so it opens
 * nothing twice.
 */
function OnThePhone() {
  const { t, locale } = useT();
  const session = useSession();
  const router = useRouter();
  const channel = t("push.channel");
  const sessionId = session.status === "signed-in" ? session.sessionId : null;

  useEffect(() => {
    Notifications.setNotificationHandler({ handleNotification: async () => IN_FRONT });
  }, []);

  useEffect(() => {
    if (sessionId === null) return;
    void registerPush({ locale, channel });
    const subscription = Notifications.addPushTokenListener((device) => {
      void registerPush({ locale, channel, device });
    });
    return () => subscription.remove();
  }, [sessionId, locale, channel]);

  const response = Notifications.useLastNotificationResponse();
  const { status } = session;
  useEffect(() => {
    // At a cold start the session is still being read: the tap waits for it.
    if (!response || status === "loading") return;
    Notifications.clearLastNotificationResponse();
    if (status !== "signed-in") return;
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const data = PushData.safeParse(response.notification.request.content.data);
    if (!data.success) return;
    router.push(data.data.kind === "round" ? "/round" : `/chats/${data.data.conversationId}`);
  }, [response, status, router]);

  return null;
}
