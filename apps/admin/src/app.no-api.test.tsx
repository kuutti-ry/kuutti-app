import { I18nProvider } from "@kuutti/i18n/react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.tsx";
import { StaffSessionProvider, useStaffSession } from "./features/identity/index.ts";
import { i18n } from "./i18n.ts";

// A production build made without VITE_API_URL (lib/api.ts): the panel has no
// address, so it sends nothing anywhere and says why it cannot sign in.
vi.mock("./lib/api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/api.ts")>()),
  API_URL: undefined,
}));

let session: ReturnType<typeof useStaffSession> | undefined;
function Grab() {
  session = useStaffSession();
  return null;
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session = undefined;
});

describe("App without an API address", () => {
  it("asks nobody, says why it cannot sign in, and keeps the button disabled", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    // Even a code in the fragment is not exchanged: there is nowhere to send it.
    window.history.replaceState(null, "", `/#code=${"c".repeat(43)}`);
    render(
      <I18nProvider i18n={i18n}>
        <StaffSessionProvider>
          <App />
        </StaffSessionProvider>
      </I18nProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This build of the panel names no API to sign in to; it was built without VITE_API_URL.",
    );
    expect(screen.getByRole("button", { name: "Sign in with your bank" })).toBeDisabled();
    expect(screen.getByRole("contentinfo")).toHaveTextContent(/The API cannot be reached/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not navigate anywhere when sign-in is asked for anyway", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const assign = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      assign,
      hash: "",
      pathname: "/",
      search: "",
      href: "http://localhost/",
    });
    render(
      <I18nProvider i18n={i18n}>
        <StaffSessionProvider>
          <Grab />
        </StaffSessionProvider>
      </I18nProvider>,
    );
    act(() => session?.signIn());
    expect(assign).not.toHaveBeenCalled();
  });
});
