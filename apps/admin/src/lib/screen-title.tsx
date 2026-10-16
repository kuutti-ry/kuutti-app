import { type ReactNode, useEffect, useRef } from "react";
import { useLocation } from "react-router";

/**
 * A screen's heading (#302). After a navigation inside the panel the focus
 * moves here, so a keyboard or screen-reader user starts on the new screen
 * and hears its name; on the first page load nothing moves (the router's
 * first location has the key "default"). Every screen's h2 is this.
 */
export function ScreenTitle({ id, children }: { id: string; children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const { key } = useLocation();
  useEffect(() => {
    if (key !== "default") ref.current?.focus();
  }, [key]);
  return (
    <h2 id={id} ref={ref} tabIndex={-1}>
      {children}
    </h2>
  );
}
