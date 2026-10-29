import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo } from "react-native";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/lib/locale";
import { readPreference, writePreference } from "@/lib/preferences";
import { useHapticTap } from "@/theme/haptics";

/**
 * The one-time hint for a screen-reader user (#296 part 3): on the first
 * launch with VoiceOver or TalkBack active, a dialog says that photos are
 * read with a description and where the setting is. Dismissed once, it is
 * remembered on the device and never shown again. The screen-reader state
 * is read here and goes nowhere else: not to the API, not into a research
 * event, not to Sentry, not into a log line; what the device keeps is that
 * the hint was seen, under a name that says nothing about why
 * (`photoDescriptionsHintSeen`). A list of who uses a screen reader is a
 * list of disabled people (article 9, ADR-019 §6).
 */
export function ScreenReaderHint() {
  const { t } = useT();
  const router = useRouter();
  const tap = useHapticTap();
  const [open, setOpen] = useState(false);
  // Null until the device has answered; true once seen, this launch or an earlier one.
  const seen = useRef<boolean | null>(null);
  const active = useRef(false);
  useEffect(() => {
    let live = true;
    const consider = () => {
      if (live && active.current && seen.current === false) setOpen(true);
    };
    void readPreference("photoDescriptionsHintSeen").then((stored) => {
      if (!live) return;
      seen.current = stored === "true";
      consider();
    });
    void AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
      if (!live) return;
      active.current = enabled;
      consider();
    });
    const subscription = AccessibilityInfo.addEventListener("screenReaderChanged", (enabled) => {
      active.current = enabled;
      consider();
    });
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);

  const close = (thenOpenTheSetting: boolean) => {
    seen.current = true;
    setOpen(false);
    void writePreference("photoDescriptionsHintSeen", "true");
    // The setting is a row of Settings that opens in place (#511): opened for the person.
    if (thenOpenTheSetting) {
      router.push({ pathname: "/settings", params: { open: "photoDescriptions" } });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close(false)}>
      <DialogContent closeLabel={t("settings.photoDescriptions.hint.close")}>
        <DialogHeader>
          <DialogTitle>{t("settings.photoDescriptions.label")}</DialogTitle>
          <DialogDescription>{t("settings.photoDescriptions.hint.body")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onPress={() => {
              tap();
              close(false);
            }}
          >
            {t("settings.photoDescriptions.hint.dismiss")}
          </Button>
          <Button
            onPress={() => {
              tap();
              close(true);
            }}
          >
            {t("settings.photoDescriptions.hint.open")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
