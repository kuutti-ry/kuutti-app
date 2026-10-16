import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "./dialog.tsx";

// The panel's modal step (#308, CLAUDE.md Accessibility): named by its title,
// the first control focused, Tab and Shift+Tab kept inside, Escape closes, and
// the focus goes back to what had it. A key event's default being prevented
// is what keeps a real browser's focus from leaving the dialog, so the tests
// read fireEvent's answer (false when prevented) besides where the focus is.

/** An opener and the dialog it opens, as a screen uses it: closing unmounts the dialog. */
function Opener({ children, opener = true }: { children: ReactNode; opener?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {opener && (
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
      )}
      {open && (
        <Dialog title="Lift: Suspension" onClose={() => setOpen(false)}>
          {children}
        </Dialog>
      )}
    </>
  );
}

const controls = (
  <>
    <label>
      Your note
      <textarea />
    </label>
    <button type="button">Apply</button>
    <button type="button">Cancel</button>
  </>
);

/** Opens the dialog from its opener, which has the focus first, as after a keyboard press. */
function open(children: ReactNode = controls) {
  render(<Opener>{children}</Opener>);
  const opener = screen.getByRole("button", { name: "Open" });
  opener.focus();
  fireEvent.click(opener);
  return { opener, dialog: screen.getByRole("dialog") };
}

afterEach(cleanup);

describe("Dialog", () => {
  it("is a modal dialog named by its title, which is its heading", () => {
    const { dialog } = open();
    expect(screen.getByRole("dialog", { name: "Lift: Suspension" })).toBe(dialog);
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("heading", { level: 3 })).toHaveTextContent("Lift: Suspension");
    // The dialog itself can hold the focus, but is no stop of the Tab order.
    expect(dialog).toHaveAttribute("tabindex", "-1");
  });

  it("focuses its first control on open, past one that is disabled", () => {
    open(
      <>
        <button type="button" disabled>
          Busy
        </button>
        {controls}
      </>,
    );
    expect(screen.getByRole("textbox", { name: "Your note" })).toHaveFocus();
  });

  it("wraps Tab from the last control to the first, and Shift+Tab from the first to the last", () => {
    open();
    const first = screen.getByRole("textbox", { name: "Your note" });
    const last = screen.getByRole("button", { name: "Cancel" });
    last.focus();
    expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
    expect(first).toHaveFocus();
    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
    expect(last).toHaveFocus();
  });

  it("wraps Shift+Tab from the dialog itself to its last control", () => {
    const { dialog } = open();
    dialog.focus();
    expect(fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true })).toBe(false);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("leaves Tab between its controls, and from the dialog itself forward, to the browser", () => {
    const { dialog } = open();
    const middle = screen.getByRole("button", { name: "Apply" });
    middle.focus();
    expect(fireEvent.keyDown(middle, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(middle, { key: "Tab", shiftKey: true })).toBe(true);
    expect(middle).toHaveFocus();
    dialog.focus();
    expect(fireEvent.keyDown(dialog, { key: "Tab" })).toBe(true);
    expect(dialog).toHaveFocus();
  });

  it("takes the focus itself when it has no control, and keeps it on Tab and Shift+Tab", () => {
    const { dialog } = open(<p>Nothing to press here.</p>);
    expect(dialog).toHaveFocus();
    expect(fireEvent.keyDown(dialog, { key: "Tab" })).toBe(false);
    expect(dialog).toHaveFocus();
    expect(fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true })).toBe(false);
    expect(dialog).toHaveFocus();
  });

  it("calls onClose on Escape, once, and the key goes no further out", () => {
    const onClose = vi.fn();
    const outer = vi.fn();
    const onDocument = vi.fn();
    document.addEventListener("keydown", onDocument);
    try {
      render(
        // biome-ignore lint/a11y/noStaticElementInteractions: a listener to see the key stop inside the dialog
        <div onKeyDown={outer}>
          <Dialog title="Warn this person" onClose={onClose}>
            {controls}
          </Dialog>
        </div>,
      );
      const note = screen.getByRole("textbox", { name: "Your note" });
      fireEvent.keyDown(note, { key: "Enter" });
      fireEvent.keyDown(note, { key: "a" });
      expect(onClose).not.toHaveBeenCalled();
      expect(outer).toHaveBeenCalledTimes(2);
      expect(onDocument).toHaveBeenCalledTimes(2);
      outer.mockClear();
      onDocument.mockClear();
      fireEvent.keyDown(note, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(outer).not.toHaveBeenCalled();
      expect(onDocument).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", onDocument);
    }
  });

  it("gives the focus back to what had it when it closes", () => {
    const { opener } = open();
    expect(opener).not.toHaveFocus();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Your note" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("does not give the focus back to what had it once that is gone", () => {
    function Gone() {
      const [opener, setOpener] = useState(true);
      return (
        <Opener opener={opener}>
          <button type="button" onClick={() => setOpener(false)}>
            Take the opener away
          </button>
        </Opener>
      );
    }
    render(<Gone />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    const focus = vi.spyOn(opener, "focus");
    fireEvent.click(screen.getByRole("button", { name: "Take the opener away" }));
    expect(opener.isConnected).toBe(false);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it("gives no focus back to an opener that is not an HTML element", () => {
    function FromAnIcon() {
      const [open, setOpen] = useState(false);
      return (
        <>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: an element that can hold the focus but is no HTML element, the case the dialog leaves alone */}
          <svg tabIndex={0} aria-label="Icon" role="img" onKeyDown={() => setOpen(true)} />
          {open && (
            <Dialog title="Warn this person" onClose={() => setOpen(false)}>
              {controls}
            </Dialog>
          )}
        </>
      );
    }
    render(<FromAnIcon />);
    const icon = screen.getByRole("img", { name: "Icon" });
    icon.focus();
    expect(icon).toHaveFocus();
    fireEvent.keyDown(icon, { key: "Enter" });
    expect(screen.getByRole("textbox", { name: "Your note" })).toHaveFocus();
    const focus = vi.spyOn(icon, "focus");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(focus).not.toHaveBeenCalled();
    expect(icon).not.toHaveFocus();
  });

  it("keeps the focus on a press beside the box, which goes no further", () => {
    const { dialog } = open();
    const backdrop = dialog.parentElement as HTMLElement;
    expect(backdrop).toHaveClass("backdrop");
    // fireEvent answers false when the default, moving the focus, was prevented.
    expect(fireEvent.mouseDown(backdrop)).toBe(false);
    // A press inside the box is the browser's to handle.
    expect(fireEvent.mouseDown(dialog)).toBe(true);
    expect(within(dialog).getByRole("textbox", { name: "Your note" })).toHaveFocus();
  });

  it("brings the focus back inside when it lands outside the box, and closes on Escape from there", () => {
    const { opener, dialog } = open();
    const note = within(dialog).getByRole("textbox", { name: "Your note" });
    opener.focus();
    expect(note).toHaveFocus();
    // Escape closes wherever the focus is, and Tab from outside goes in.
    note.blur();
    expect(document.body).toHaveFocus();
    expect(fireEvent.keyDown(document.body, { key: "Tab" })).toBe(false);
    expect(note).toHaveFocus();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("makes the rest of the page inert while it is open, and gives it back, leaving inert what was already", () => {
    const already = document.createElement("div");
    already.setAttribute("inert", "");
    document.body.append(already);
    const { opener, dialog } = open();
    const page = opener.closest("body > *") as HTMLElement;
    const layer = dialog.parentElement as HTMLElement;
    expect(layer.parentElement).toBe(document.body);
    expect(page).toHaveAttribute("inert");
    expect(layer).not.toHaveAttribute("inert");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(page).not.toHaveAttribute("inert");
    expect(already).toHaveAttribute("inert");
    already.remove();
  });
});
