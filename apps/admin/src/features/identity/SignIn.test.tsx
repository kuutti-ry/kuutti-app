import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { SignIn } from "./SignIn.tsx";
import { StaffSessionProvider } from "./session.tsx";

// The signed-out panel (#49): the bank login, with the refusal the return URL
// carried in words a moderator can act on.

function show() {
  render(
    <I18nProvider i18n={i18n}>
      <StaffSessionProvider>
        <SignIn />
      </StaffSessionProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SignIn", () => {
  it("explains the bank login under its heading and shows no alert when nothing went wrong", async () => {
    show();
    expect(await screen.findByRole("heading", { level: 2, name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByText(/Moderators sign in with their bank/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in with your bank" })).toBeEnabled();
  });

  it("names a refusal it knows", async () => {
    window.history.replaceState(null, "", "/#error=admin_not_allowed");
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That bank login has no moderator role. Ask the maintainer to add it.",
    );
    expect(screen.getByRole("button", { name: "Sign in with your bank" })).toBeEnabled();
  });

  it("falls back to the generic message for a refusal it does not know", async () => {
    window.history.replaceState(null, "", "/#error=state_mismatch");
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sign-in did not complete. Try again.",
    );
    // The raw code is never shown.
    expect(screen.queryByText(/state_mismatch/)).toBeNull();
  });

  it("starts the staff login of the API when pressed", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      assign,
      hash: "",
      pathname: "/",
      search: "",
      href: "http://localhost/",
    });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with your bank" }));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("http://localhost:3000/admin/auth/start");
  });
});
