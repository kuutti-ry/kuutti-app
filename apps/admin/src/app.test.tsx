import { formatTime } from "@kuutti/i18n";
import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.tsx";
import { StaffSessionProvider } from "./features/identity/index.ts";
import { i18n } from "./i18n.ts";
import { apiUrl } from "./source-offer.tsx";

const health = {
  status: "ok",
  version: "0.0.0-test",
  commit: "abc1234",
  builtAt: "2026-09-13T00:00:00.000Z",
  source: "https://codeberg.org/example/kuutti-fork",
  db: "ok",
  migrations: "current",
};

function renderApp(answer: (input?: Request | string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(answer));
  render(
    <I18nProvider i18n={i18n}>
      <StaffSessionProvider>
        <App />
      </StaffSessionProvider>
    </I18nProvider>,
  );
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const staff = {
  accessToken: "a".repeat(43),
  expiresAt: "2030-01-01T08:00:00.000Z",
  role: "moderator",
};

/** The API a signed-in panel talks to, by method and path; records what was asked. */
function staffApi(role = "moderator", calls: string[] = [], options = { logoutFails: false }) {
  return async (input?: Request | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input ?? "", init);
    const key = `${req.method} ${new URL(req.url).pathname}`;
    calls.push(key);
    if (key === "GET /health") return json(health);
    if (key === "GET /admin/whoami") return json({ role, expiresAt: staff.expiresAt });
    if (key === "GET /admin/photos/queue") return json({ items: [], total: 0 });
    if (key === "GET /admin/feedback") return json({ items: [], total: 0 });
    if (key === "POST /admin/auth/logout") {
      if (options.logoutFails) throw new TypeError("Failed to fetch");
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${key}`);
  };
}

describe("App", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });
  // Without vitest globals, Testing Library does not unmount between tests by itself.
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the heading from messages.yaml and, signed out, the bank login", async () => {
    renderApp(async () => json(health));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Kuutti admin");
    expect(
      await screen.findByRole("button", { name: "Sign in with your bank" }),
    ).toBeInTheDocument();
  });

  it("offers the source the running API names, with its commit (AGPL-3.0 section 13)", async () => {
    renderApp(async () => json(health));
    const link = await screen.findByRole("link", {
      name: "https://codeberg.org/example/kuutti-fork",
    });
    expect(link).toHaveAttribute("href", "https://codeberg.org/example/kuutti-fork");
    expect(screen.getByRole("contentinfo")).toHaveTextContent("commit abc1234");
  });

  it("says so when the API cannot be reached, and never links an address that is not https", async () => {
    renderApp(async () => json({ ...health, source: "javascript:alert(1)" }));
    expect(await screen.findByText(/The API cannot be reached/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("is busy while a sign-in is being completed", () => {
    window.history.replaceState(null, "", `/#code=${"c".repeat(43)}`);
    renderApp(() => new Promise<Response>(() => {}));
    expect(screen.getByText("Loading the queue…")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("button", { name: "Sign in with your bank" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("signed in as a moderator, names the role and the session's end and opens the queue", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    renderApp(staffApi());
    expect(await screen.findByText(/Signed in as moderator/)).toHaveTextContent(
      `Session ends: ${formatTime("en", new Date(staff.expiresAt))}`,
    );
    expect(
      await screen.findByRole("heading", { level: 2, name: "Photo review queue" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Your role does not allow the photo queue.")).toBeNull();
  });

  it("signed in as a researcher, says the role does not allow the queue and never asks for it", async () => {
    window.sessionStorage.setItem(
      "kuutti.admin.session",
      JSON.stringify({ ...staff, role: "researcher" }),
    );
    const calls: string[] = [];
    renderApp(staffApi("researcher", calls));
    expect(
      await screen.findByText("Your role does not allow the photo queue."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Signed in as researcher/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Photo review queue" })).toBeNull();
    expect(calls).not.toContain("GET /admin/photos/queue");
  });

  it("a session revoked while the panel is open goes back to the sign-in, saying so (#250)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    const signedIn = staffApi();
    renderApp(async (input, init) => {
      const req = input instanceof Request ? input : new Request(input ?? "", init);
      // The role was taken away after the panel opened: the queue's request is refused.
      if (new URL(req.url).pathname === "/admin/photos/queue") {
        return new Response(
          JSON.stringify({ error: { code: "session_revoked", message: "x", requestId: "r" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      return signedIn(input, init);
    });
    expect(await screen.findByText("Your session has ended. Sign in again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with your bank" })).toBeInTheDocument();
    expect(screen.queryByText("The queue could not be loaded.")).toBeNull();
    expect(window.sessionStorage.getItem("kuutti.admin.session")).toBeNull();
  });

  it("signs out through the API, forgets the session and offers the bank login again", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    const calls: string[] = [];
    renderApp(staffApi("moderator", calls));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(
      await screen.findByRole("button", { name: "Sign in with your bank" }),
    ).toBeInTheDocument();
    expect(calls).toContain("POST /admin/auth/logout");
    expect(window.sessionStorage.getItem("kuutti.admin.session")).toBeNull();
    expect(screen.queryByText(/Signed in as/)).toBeNull();
  });

  it("signs out locally even when the API cannot be reached for the logout", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    renderApp(staffApi("moderator", [], { logoutFails: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Sign in with your bank" })).toBeInTheDocument(),
    );
    expect(window.sessionStorage.getItem("kuutti.admin.session")).toBeNull();
  });

  it("falls back to the local API on a development server only, never in a production build", () => {
    expect(apiUrl({ PROD: false })).toBe("http://localhost:3000");
    expect(apiUrl({ PROD: true })).toBeUndefined();
    expect(apiUrl({ PROD: true, VITE_API_URL: "https://api.kuutti.app" })).toBe(
      "https://api.kuutti.app",
    );
  });

  it("makes an unknown key a type error", () => {
    // Compile-time assertion: tsc fails on an unused @ts-expect-error.
    const probe = (t: import("@kuutti/i18n").TFunction) => {
      // @ts-expect-error not a key of messages.yaml
      t("does.not.exist");
    };
    expect(probe).toBeTypeOf("function");
  });
});
