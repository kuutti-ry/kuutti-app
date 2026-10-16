import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { BrowserRouter, MemoryRouter, Navigate, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n.ts";
import { NavigationFocus, ScreenTitle } from "./screen-title.tsx";

// A screen's heading (#302): the focus moves to it after the person's own
// move inside the panel, never when the panel loads (at a deep path, on a
// reload, or through the front page's redirect); it names the page's title.

function Go({ to, replace = false }: { to: string; replace?: boolean }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to, { replace })}>
      {`Go ${to}`}
    </button>
  );
}

const Screen = ({ name }: { name: string }) => (
  <>
    <Go to="/one" />
    <Go to="/two" />
    <Go to="/" />
    <ScreenTitle id={`${name}-title`}>{name}</ScreenTitle>
  </>
);

/** Two screens and a front page that redirects, like the shell. */
function routes() {
  return (
    <NavigationFocus>
      <Routes>
        <Route path="/" element={<Navigate to="/one" replace />} />
        <Route path="/one" element={<Screen name="One" />} />
        <Route path="/two" element={<Screen name="Two" />} />
      </Routes>
    </NavigationFocus>
  );
}

function shell(children: ReactNode) {
  return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  document.title = "Kuutti admin";
});
afterEach(cleanup);

describe("ScreenTitle", () => {
  it("is a level-two heading the panel can focus, with its id", () => {
    render(shell(<MemoryRouter initialEntries={["/one"]}>{routes()}</MemoryRouter>));
    const heading = screen.getByRole("heading", { level: 2, name: "One" });
    expect(heading).toHaveAttribute("id", "One-title");
    expect(heading).toHaveAttribute("tabindex", "-1");
  });

  it("leaves the focus alone when the panel loads at a screen's own address", () => {
    render(shell(<MemoryRouter initialEntries={["/two"]}>{routes()}</MemoryRouter>));
    expect(screen.getByRole("heading", { name: "Two" })).not.toHaveFocus();
  });

  it("leaves the focus alone when the panel loads at the front page and is sent on to a screen", async () => {
    render(shell(<MemoryRouter initialEntries={["/"]}>{routes()}</MemoryRouter>));
    const heading = await screen.findByRole("heading", { name: "One" });
    // Give the redirect's effects their turn before looking.
    await waitFor(() => expect(heading).toBeInTheDocument());
    expect(heading).not.toHaveFocus();
  });

  it("leaves the focus alone on a reload of a page the person had moved to", () => {
    // A reload keeps the history entry's key: the first location is not "default".
    window.history.replaceState({ usr: null, key: "k1", idx: 1 }, "", "/two");
    render(shell(<BrowserRouter>{routes()}</BrowserRouter>));
    expect(screen.getByRole("heading", { name: "Two" })).not.toHaveFocus();
  });

  it("takes the focus after the person moves to another screen", async () => {
    render(shell(<MemoryRouter initialEntries={["/one"]}>{routes()}</MemoryRouter>));
    fireEvent.click(screen.getByRole("button", { name: "Go /two" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Two" })).toHaveFocus());
  });

  it("takes the focus when the person goes to the front page and is sent on from there", async () => {
    render(shell(<MemoryRouter initialEntries={["/two"]}>{routes()}</MemoryRouter>));
    fireEvent.click(screen.getByRole("button", { name: "Go /" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "One" })).toHaveFocus());
  });

  it("takes the focus again on every later move", async () => {
    render(shell(<MemoryRouter initialEntries={["/one"]}>{routes()}</MemoryRouter>));
    fireEvent.click(screen.getByRole("button", { name: "Go /two" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Two" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Go /one" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "One" })).toHaveFocus());
  });

  it("never moves the focus without NavigationFocus around it", async () => {
    render(
      shell(
        <MemoryRouter initialEntries={["/one"]}>
          <Go to="/two" />
          <ScreenTitle id="probe-title">Probe</ScreenTitle>
        </MemoryRouter>,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Go /two" }));
    expect(screen.getByRole("heading", { name: "Probe" })).not.toHaveFocus();
  });

  it("names the page in the browser's title, and gives the panel's name back when it goes", () => {
    const { unmount } = render(
      shell(<MemoryRouter initialEntries={["/two"]}>{routes()}</MemoryRouter>),
    );
    expect(document.title).toBe("Two · Kuutti admin");
    unmount();
    expect(document.title).toBe("Kuutti admin");
  });
});
