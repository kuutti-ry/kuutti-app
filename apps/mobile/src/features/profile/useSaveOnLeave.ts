import { type Href, useNavigation, useRouter } from "expo-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { currentSession } from "@/lib/session";

/**
 * Drafts the API refused after their screen had gone, by screen (#238). A
 * refused screen comes back on top of whatever is open; each saves only its
 * own changes, so neither undoes the other.
 */
const refusedDrafts = new Map<string, unknown>();

/** The draft this screen was opened again for, read once. */
export function useRefusedDraft<Draft>(screen: string): Draft | undefined {
  const [held] = useState(() => refusedDrafts.get(screen) as Draft | undefined);
  useEffect(() => {
    refusedDrafts.delete(screen);
  }, [screen]);
  return held;
}

/**
 * A screen with no Save button (#227): leaving (the back button, the swipe,
 * Android's back key) saves once when something changed. The leaving is never
 * held up: held, the native swipe on iOS popped the screen, put it back and
 * popped it again (#238). So the save goes as the screen goes, and a refusal
 * brings the screen back at `path` with the draft, where `asking` says why and
 * asks before leaving without saving.
 *
 * `save` starts the save and answers the draft to bring back if it is refused,
 * or null for nothing to save and no draft to hold.
 */
export function useSaveOnLeave<Draft>({
  screen,
  path,
  held,
  save,
}: {
  screen: string;
  path: Href;
  /** Whether this screen was opened again for a refused draft. */
  held: boolean;
  save: () => Promise<Draft | null> | null;
}) {
  const router = useRouter();
  const navigation = useNavigation();
  const [asking, setAsking] = useState(held);
  // Once per screen: saved on the way out, or let go unsaved on the word.
  const left = useRef(false);
  const onLeave = useEffectEvent(() => {
    if (left.current) return;
    const saving = save();
    if (!saving) return;
    left.current = true;
    void saving.then((draft) => {
      // A session that ended has taken the person to the sign-in, and the draft with it.
      if (!draft || !currentSession()) return;
      refusedDrafts.set(screen, draft);
      router.push(path);
    });
  });
  useEffect(() => navigation.addListener("beforeRemove", () => onLeave()), [navigation]);
  return {
    asking,
    keep: () => setAsking(false),
    leave: () => {
      left.current = true;
      setAsking(false);
      router.back();
    },
  };
}
