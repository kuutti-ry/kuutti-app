import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { ScreenTitle } from "./screen-title.tsx";

// A screen's heading (#302): it takes the focus after a navigation inside the
// panel, and never on the first load.

function Go() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/elsewhere")}>
      Go
    </button>
  );
}

afterEach(cleanup);

describe("ScreenTitle", () => {
  it("is a level-two heading the panel can focus, with its id", () => {
    render(
      <MemoryRouter>
        <ScreenTitle id="probe-title">Probe</ScreenTitle>
      </MemoryRouter>,
    );
    const heading = screen.getByRole("heading", { level: 2, name: "Probe" });
    expect(heading).toHaveAttribute("id", "probe-title");
    expect(heading).toHaveAttribute("tabindex", "-1");
  });

  it("leaves the focus alone on the first load", () => {
    render(
      <MemoryRouter>
        <ScreenTitle id="probe-title">Probe</ScreenTitle>
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Probe" })).not.toHaveFocus();
  });

  it("takes the focus after a navigation", async () => {
    render(
      <MemoryRouter>
        <Go />
        <ScreenTitle id="probe-title">Probe</ScreenTitle>
      </MemoryRouter>,
    );
    const button = screen.getByRole("button", { name: "Go" });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Probe" })).toHaveFocus());
  });
});
