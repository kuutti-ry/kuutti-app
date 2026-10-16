import { type ReactNode, useEffect, useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

// A modal step (#308): labelled by its title, drawn over the page from the
// end of <body>, and the page behind made inert while it is open, so neither
// a pointer, a Tab nor a screen reader reaches what the step hides. The focus
// stays inside (Tab and Shift+Tab wrap around; a press on the backdrop keeps
// it; focus moved out any other way comes back), Escape closes it wherever
// the focus is, and on closing the focus goes back to what had it before.
// Plain HTML, no library (rules/admin.md).

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const layer = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // The latest onClose, so the listeners set once at opening never call a stale one.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  // A layout effect, so the page is inert and the focus inside before the step is painted, and
  // given back in the same commit that removes the step, never a moment later.
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const inside = (node: EventTarget | null) =>
      node instanceof Node && box.current?.contains(node) === true;
    const controls = () => [...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const enter = () => (controls()[0] ?? box.current)?.focus();

    // The rest of <body> goes inert while the step is open; what was inert already stays so.
    const others = [...document.body.children].filter(
      (node) => node !== layer.current && !node.hasAttribute("inert"),
    );
    for (const node of others) node.setAttribute("inert", "");
    enter();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = controls();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const at = document.activeElement;
      if (event.shiftKey && (at === first || at === box.current || !inside(at))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (at === last || !inside(at))) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (!inside(event.target)) enter();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus);
      for (const node of others) node.removeAttribute("inert");
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return createPortal(
    // A press beside the box keeps the focus where it is.
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop only keeps a pointer press from moving the focus; the keyboard is handled at the document.
    <div
      ref={layer}
      className="backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.preventDefault();
      }}
    >
      <div
        ref={box}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
      >
        <h3 id={id}>{title}</h3>
        {children}
      </div>
    </div>,
    document.body,
  );
}
