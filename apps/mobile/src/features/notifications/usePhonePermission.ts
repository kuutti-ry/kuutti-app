import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useT } from "@/lib/locale";
import { askPermission, type PhonePermission, readPermission, registerPush } from "./phone";

/**
 * The phone's permission for a screen (ADR-055 §9): read as it opens and
 * again whenever the app comes back to the front, since the person may have
 * changed it in the phone's settings meanwhile; null until read. `ask` shows
 * the phone's own question. Whenever the permission becomes allowed here, by
 * the question or in the phone's settings, the token is registered at once
 * rather than at the next start.
 */
export function usePhonePermission(): {
  permission: PhonePermission | null;
  ask: () => Promise<void>;
} {
  const { t, locale } = useT();
  const channel = t("push.channel");
  const [permission, setPermission] = useState<PhonePermission | null>(null);
  const known = useRef<PhonePermission | null>(null);
  const live = useRef(true);

  const settle = useCallback(
    (next: PhonePermission) => {
      if (!live.current) return;
      const before = known.current;
      known.current = next;
      setPermission(next);
      if (next === "allowed" && before !== null && before !== "allowed") {
        void registerPush({ locale, channel });
      }
    },
    [locale, channel],
  );

  useEffect(() => {
    live.current = true;
    const read = () => void readPermission().then(settle);
    read();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") read();
    });
    return () => {
      live.current = false;
      subscription.remove();
    };
  }, [settle]);

  const ask = useCallback(async () => {
    settle(await askPermission(channel));
  }, [channel, settle]);

  return { permission, ask };
}
