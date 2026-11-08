import type { PlainMessageKey } from "@kuutti/i18n";
import * as Sentry from "@sentry/react-native";
import { useEffect, useRef } from "react";
import { Linking, View } from "react-native";
import { sayAloud } from "@/components/Notice";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import type { PhonePermission } from "./phone";
import { usePhonePermission } from "./usePhonePermission";

const WORDS: Record<PhonePermission, PlainMessageKey> = {
  allowed: "notifications.phone.allowed",
  denied: "notifications.phone.denied",
  undetermined: "notifications.phone.undetermined",
  unavailable: "notifications.phone.unavailable",
};

/**
 * What this phone's answer leaves to do (#102, ADR-055 §9), first on Settings ›
 * Notifications, read again as the app comes back from the phone's settings.
 * The row's value right above says whether it is allowed (#581). A refusal has
 * the way to the phone's settings, on both platforms; a phone never asked has
 * the button that shows the phone's own question, which waits while the
 * question is open and on iOS is the only way its settings ever get a
 * Notifications row for Kuutti. No dialog of ours asks. Only a device that
 * cannot show them says so in a line, where the value looks as usual. A change
 * after the first read is said aloud.
 */
export function PhoneLine() {
  const { t } = useT();
  const tap = useHapticTap();
  const { permission, asking, ask } = usePhonePermission();
  const line = permission === null ? null : t(WORDS[permission]);
  const shown = useRef<PhonePermission | null>(null);
  useEffect(() => {
    if (line === null) return;
    const before = shown.current;
    shown.current = permission;
    if (before !== null && before !== permission) sayAloud(line);
  }, [permission, line]);
  if (line === null || permission === "allowed") return null;
  return (
    <View className="gap-2">
      {permission === "unavailable" && <Text>{line}</Text>}
      {permission === "denied" && (
        <Button
          variant="outline"
          onPress={() => {
            tap();
            // A phone whose settings cannot be opened is reported, the error alone.
            Linking.openSettings().catch((error: unknown) => Sentry.captureException(error));
          }}
        >
          {t("notifications.phone.openSettings")}
        </Button>
      )}
      {permission === "undetermined" && (
        <Button
          variant="outline"
          disabled={asking}
          onPress={() => {
            tap();
            void ask();
          }}
        >
          {t("notifications.allow")}
        </Button>
      )}
    </View>
  );
}
