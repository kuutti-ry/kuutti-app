import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useStatusFocus } from "./status-focus.ts";

// A decision's outcome is said in a status line that takes the focus (#308).

afterEach(cleanup);

function Line({ said }: { said: string }) {
  const line = useStatusFocus(said);
  return (
    <p ref={line} role="status" tabIndex={-1}>
      {said}
    </p>
  );
}

describe("useStatusFocus", () => {
  it("leaves the focus where it is while there is nothing to say", () => {
    render(<Line said="" />);
    expect(document.activeElement).toBe(document.body);
  });

  it("moves the focus to the line once something is said, and again for new words", () => {
    const view = render(<Line said="" />);
    view.rerender(<Line said="Ban applied." />);
    expect(document.activeElement).toBe(screen.getByRole("status"));
    (document.activeElement as HTMLElement).blur();
    view.rerender(<Line said="Ban lifted." />);
    expect(document.activeElement).toBe(screen.getByRole("status"));
  });
});
