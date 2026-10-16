import { useT } from "@kuutti/i18n/react";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { useLocation, useNavigationType } from "react-router";

// A screen's heading and the page's title (#302). After the person moves
// inside the panel the focus goes to the new screen's heading, so a keyboard
// or screen-reader user starts there and hears its name. Nothing moves when
// the panel loads, whether at a deep path or on a reload, and a redirect is a
// replace the person did not make.

/** How many times the person has moved since the panel loaded; 0 until the first move. */
const Moves = createContext(0);

/** Around the routes: counts the person's own moves, not the load and not a redirect's replace. */
export function NavigationFocus({ children }: { children: ReactNode }) {
  const { key } = useLocation();
  const type = useNavigationType();
  const loadedAt = useRef(key);
  const [moves, setMoves] = useState(0);
  useEffect(() => {
    if (key === loadedAt.current) return;
    setMoves((count) => (count === 0 && type === "REPLACE" ? 0 : count + 1));
  }, [key, type]);
  return <Moves.Provider value={moves}>{children}</Moves.Provider>;
}

/** Every screen's h2: it takes the focus after a move, and names the page in the browser's title. */
export function ScreenTitle({ id, children }: { id: string; children: string }) {
  const { t } = useT();
  const ref = useRef<HTMLHeadingElement>(null);
  const moves = useContext(Moves);
  useEffect(() => {
    if (moves > 0) ref.current?.focus();
  }, [moves]);
  useEffect(() => {
    document.title = `${children} · ${t("admin.title")}`;
    return () => {
      document.title = t("admin.title");
    };
  }, [children, t]);
  return (
    <h2 id={id} ref={ref} tabIndex={-1}>
      {children}
    </h2>
  );
}
