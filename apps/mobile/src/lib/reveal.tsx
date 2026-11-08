import { createContext, useContext, useEffect, useRef } from "react";
import type { View } from "react-native";

/**
 * How a page brings a part of itself into sight (#511): Settings gives its
 * own (useReveal in features/settings), so that what a panel shows after a
 * press, below the fold, comes up where the person can read it; elsewhere
 * there is none, and nothing scrolls.
 */
const RevealContext = createContext<((part: View) => void) | null>(null);

export const RevealProvider = RevealContext.Provider;

/**
 * A ref for a part that the page brings into sight whenever `shown` names a
 * new thing in it (a code just made), a frame after it is drawn; null while
 * it shows nothing.
 */
export function useRevealOn(shown: string | null) {
  const reveal = useContext(RevealContext);
  const part = useRef<View>(null);
  useEffect(() => {
    if (shown === null || reveal === null) return;
    const frame = requestAnimationFrame(() => {
      if (part.current) reveal(part.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [shown, reveal]);
  return part;
}
