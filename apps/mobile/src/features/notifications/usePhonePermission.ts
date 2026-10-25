import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useT } from "@/lib/locale";
import {
  askPermission,
  onPhone,
  type PhonePermission,
  readPermission,
  registerPush,
} from "./phone";

/**
 * The phone's permission for a screen (ADR-055 §9): read as it opens and
 * again whenever the app comes back to the front, since the person may have
 * changed it in the phone's settings meanwhile; null until read. On the web
 * target it is unavailable from the start, and nothing is read, listened for
 * or asked. `ask` shows the phone's own question, and `asking` holds while it
 * is open, so that a second tap does not ask again. A yes to it registers the
 * token at once rather than at the next start; one given in the phone's
 * settings is registered as the app comes back to the front, wherever it is
 * (`PushNotifications`).
 */
export function usePhonePermission(): {
  permission: PhonePermission | null;
  asking: boolean;
  ask: () => Promise<void>;
} {
  const { t, locale } = useT();
  const channel = t("push.channel");
  const [permission, setPermission] = useState<PhonePermission | null>(() =>
    onPhone() ? null : "unavailable",
  );
  const [asking, setAsking] = useState(false);
  const live = useRef(true);

  useEffect(() => {
    if (!onPhone()) return;
    live.current = true;
    const read = () =>
      void readPermission().then((next) => {
        if (live.current) setPermission(next);
      });
    read();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") read();
    });
    return () => {
      live.current = false;
      subscription.remove();
    };
  }, []);

  const ask = useCallback(async () => {
    setAsking(true);
    // askPermission reports its own failure and never throws.
    const answer = await askPermission(channel);
    if (!live.current) return;
    setPermission(answer);
    setAsking(false);
    if (answer === "allowed") void registerPush({ locale, channel });
  }, [locale, channel]);

  return { permission, asking, ask };
}
