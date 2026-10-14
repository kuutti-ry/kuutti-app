import { useNavigation } from "expo-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
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

/**
 * Asks before a screen with unsaved changes is left: they are never dropped
 * without the person's word (14/10/2026). The arrow, Android's back key and a
 * pop of several screens all pass through `beforeRemove`, which is held while
 * the screen holds something unsaved, the one in front or one under it that
 * the pop would take along (deal-breakers under a question opened from it).
 * The dialog shows over whatever is in front, from the root's portal. The iOS
 * swipe is off meanwhile: held, the native swipe pops the screen, puts it back
 * and pops it again (#238), so it cannot be held, only not begun.
 */
// shortcut: a link from outside the app (kuutti://…) takes the screen away
// without passing beforeRemove, so it is not asked about (seen on the Android
// emulator, 14/10/2026). Today only tests and typed links do that; a check of
// the unsaved state where links come in (Expo Router's +native-intent) would
// lift it, once links can arrive mid-edit (push, #102).
export function useConfirmLeave(unsaved: boolean) {
  const navigation = useNavigation();
  // The leaving that was held, to carry out on the person's word.
  const [pending, setPending] = useState<(() => void) | null>(null);
  const letGo = useRef(false);
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !unsaved });
  }, [navigation, unsaved]);
  const holds = useEffectEvent(() => unsaved && !letGo.current);
  useEffect(
    () =>
      navigation.addListener("beforeRemove", (event) => {
        if (!holds()) return;
        event.preventDefault();
        setPending(() => () => navigation.dispatch(event.data.action));
      }),
    [navigation],
  );
  return {
    asking: pending !== null,
    keep: () => setPending(null),
    leave: () => {
      letGo.current = true;
      setPending(null);
      pending?.();
    },
  };
}

/** The question itself, in the words of the sections' dialog (#227). */
export function ConfirmLeaveDialog({ asking, keep, leave }: ReturnType<typeof useConfirmLeave>) {
  const { t } = useT();
  return (
    <Dialog open={asking} onOpenChange={(open) => !open && keep()}>
      <DialogContent closeLabel={t("profile.discard.close")}>
        <DialogHeader>
          <DialogTitle>{t("profile.discard.title")}</DialogTitle>
          <DialogDescription>{t("profile.discard.unsaved")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onPress={keep}>
            {t("profile.discard.keep")}
          </Button>
          <Button variant="destructive" onPress={leave}>
            {t("profile.discard.leave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
