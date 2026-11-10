import { useEffect, useRef } from "react";

/**
 * The status line a decision's outcome is said in, which takes the focus once
 * there is something to say (#308): where the step was, a screen reader hears
 * what came of it. Called where the screen's own effect stood.
 */
export function useStatusFocus(said: unknown) {
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (said) line.current?.focus();
  }, [said]);
  return line;
}
