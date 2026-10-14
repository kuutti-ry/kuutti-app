import { useNavigation } from "expo-router";
import { useEffect, useRef, useState } from "react";
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

/** A leaving that was held: carried out on the person's word, or called off. */
type Held = { go: () => void; stay?: () => void };

/** A screen that may hold something unsaved; the one in front is registered last. */
type Holder = { holds: () => boolean; hold: (held: Held) => void };
const holders: Holder[] = [];

/**
 * Asks before a screen with unsaved changes is left: they are never dropped
 * without the person's word (14/10/2026). The arrow, Android's back key and a
 * pop of several screens all pass through `beforeRemove`, which is held while
 * the screen holds something unsaved, the one in front or one under it that
 * the pop would take along (deal-breakers under a question opened from it).
 * The dialog shows over whatever is in front, from the root's portal. The iOS
 * swipe is off meanwhile: held, the native swipe pops the screen, puts it back
 * and pops it again (#238), so it cannot be held, only not begun.
 *
 * On the word, the screen first drops what was unsaved (`discard`, the
 * screen's own reset to what is stored), then the held leaving goes on. The
 * dispatched action carries the screens it has already asked (React
 * Navigation's VISITED_ROUTE_KEYS, useOnPreventRemove), so this screen is not
 * asked twice, and a screen under it is asked next. A link from outside the
 * app is held the same way (`holdLinkWhileUnsaved`); it pushes rather than
 * pops, so the screen may stay mounted under it, holding nothing any more.
 */
export function useConfirmLeave(unsaved: boolean, discard: () => void) {
  const navigation = useNavigation();
  const [pending, setPending] = useState<Held | null>(null);
  // Read by the listeners, which outlive a render.
  const unsavedNow = useRef(unsaved);
  useEffect(() => {
    unsavedNow.current = unsaved;
    navigation.setOptions({ gestureEnabled: !unsaved });
  }, [navigation, unsaved]);
  useEffect(() => {
    const holder: Holder = {
      holds: () => unsavedNow.current,
      hold: (held) => setPending(held),
    };
    holders.push(holder);
    const away = navigation.addListener("beforeRemove", (event) => {
      if (!holder.holds()) return;
      event.preventDefault();
      holder.hold({ go: () => navigation.dispatch(event.data.action) });
    });
    return () => {
      away();
      holders.splice(holders.indexOf(holder), 1);
    };
  }, [navigation]);
  return {
    asking: pending !== null,
    keep: () => {
      setPending(null);
      pending?.stay?.();
    },
    leave: () => {
      setPending(null);
      discard();
      pending?.go();
    },
  };
}

/**
 * A link from outside the app (`kuutti://…`) while a screen holds something
 * unsaved (#285): the link waits for the person's word, in the same dialog as
 * the arrow, and is followed on "Leave without saving" or dropped on "Keep
 * editing". Expo Router applies the path this resolves to and drops the link
 * on null (`app/+native-intent.ts`). The first link of a cold start passes:
 * nothing is unsaved yet.
 */
export function holdLinkWhileUnsaved(
  path: string,
  initial: boolean,
): string | Promise<string | null> {
  if (initial) return path;
  for (let i = holders.length - 1; i >= 0; i--) {
    const holder = holders[i];
    if (holder?.holds()) {
      return new Promise((resolve) => {
        holder.hold({ go: () => resolve(path), stay: () => resolve(null) });
      });
    }
  }
  return path;
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
