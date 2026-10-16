import { formatTime } from "@kuutti/i18n";
import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BrowserRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.tsx";
import { restoreReturnPath, StaffSessionProvider } from "./features/identity/index.ts";
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
        <BrowserRouter>
          <App />
        </BrowserRouter>
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

const refused = () =>
  new Response(
    JSON.stringify({ error: { code: "admin_forbidden", message: "x", requestId: "r" } }),
    { status: 403, headers: { "content-type": "application/json" } },
  );

/** The API a signed-in panel talks to, by method and path; records what was asked. */
function staffApi(
  role = "moderator",
  calls: string[] = [],
  options: { logoutFails?: boolean; answers?: Record<string, () => Response> } = {},
) {
  return async (input?: Request | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input ?? "", init);
    const key = `${req.method} ${new URL(req.url).pathname}`;
    calls.push(key);
    const answer = options.answers?.[key];
    if (answer) return answer();
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
    // The skip link is the page's own; the footer links nothing.
    expect(within(screen.getByRole("contentinfo")).queryByRole("link")).toBeNull();
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
    expect(screen.queryByText("Your role does not open any screen of this panel.")).toBeNull();
  });

  it("signed in as a researcher, shows no menu, says the role opens no screen and never asks for one", async () => {
    window.sessionStorage.setItem(
      "kuutti.admin.session",
      JSON.stringify({ ...staff, role: "researcher" }),
    );
    const calls: string[] = [];
    renderApp(staffApi("researcher", calls));
    expect(
      await screen.findByText("Your role does not open any screen of this panel."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Signed in as researcher/)).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Photo review queue" })).toBeNull();
    expect(calls).not.toContain("GET /admin/photos/queue");
    expect(calls).not.toContain("GET /admin/feedback");
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

  it("opens the first screen the role allows at the front page, the menu marking where the person is (#302)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    renderApp(staffApi());
    expect(
      await screen.findByRole("heading", { level: 2, name: "Photo review queue" }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/photos");
    const menu = screen.getByRole("navigation", { name: "Screens" });
    const links = within(menu).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Photos", "Feedback"]);
    expect(within(menu).getByRole("link", { name: "Photos" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(menu).getByRole("link", { name: "Feedback" })).not.toHaveAttribute(
      "aria-current",
    );
    // The front page's redirect is not the person's move: nothing takes the focus.
    expect(screen.getByRole("heading", { level: 2, name: "Photo review queue" })).not.toHaveFocus();
    expect(document.title).toBe("Photo review queue · Kuutti admin");
  });

  it("moves between screens by the menu, and the new screen's heading takes the focus (#302)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    const calls: string[] = [];
    renderApp(staffApi("admin", calls));
    const menu = await screen.findByRole("navigation", { name: "Screens" });
    fireEvent.click(within(menu).getByRole("link", { name: "Feedback" }));
    const heading = await screen.findByRole("heading", { level: 2, name: "Feedback" });
    expect(window.location.pathname).toBe("/feedback");
    await waitFor(() => expect(heading).toHaveFocus());
    expect(within(menu).getByRole("link", { name: "Feedback" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("heading", { name: "Photo review queue" })).toBeNull();
    expect(calls).toContain("GET /admin/feedback");
  });

  it("opens a screen from its own address, without taking the focus on the first load (#302)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    window.history.replaceState(null, "", "/feedback");
    const calls: string[] = [];
    renderApp(staffApi("moderator", calls));
    const heading = await screen.findByRole("heading", { level: 2, name: "Feedback" });
    expect(heading).not.toHaveFocus();
    expect(calls).not.toContain("GET /admin/photos/queue");
  });

  it("says there is nothing at an address the panel does not have, and links back to the start (#302)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    window.history.replaceState(null, "", "/no/such/screen");
    renderApp(staffApi());
    expect(
      await screen.findByRole("heading", { level: 2, name: "Nothing at this address" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Back to the start" }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Photo review queue" }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/photos");
  });

  it("says once that the role does not allow it when the API answers 403, never as the screen's failure, and not again once the role is honoured (#302)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    let refuse = true;
    renderApp(
      staffApi("moderator", [], {
        answers: {
          "GET /admin/photos/queue": () => (refuse ? refused() : json({ items: [], total: 0 })),
        },
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow this.");
    expect(screen.queryByText("The queue could not be loaded.")).toBeNull();
    // A second refusal on the same visit says nothing new.
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByText("Loading the queue…")).toBeNull());
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    // The session is not ended by a 403: the person is still signed in.
    expect(screen.getByText(/Signed in as moderator/)).toBeInTheDocument();
    // The role is given back: the next answer takes the notice away.
    refuse = false;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Nothing waiting")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not bring a refusal back when the person returns to the screen it was said on (#302)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    let refuse = true;
    renderApp(
      staffApi("moderator", [], {
        answers: {
          "GET /admin/photos/queue": () => (refuse ? refused() : json({ items: [], total: 0 })),
          // The feedback list is not asked again for the role: it stays quiet either way.
          "GET /admin/feedback": () => refused(),
        },
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow this.");
    refuse = false;
    fireEvent.click(screen.getByRole("link", { name: "Feedback" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Feedback" })).toBeInTheDocument();
    // Refused on this visit too: said here, once.
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow this.");
    fireEvent.click(screen.getByRole("link", { name: "Photos" }));
    expect(await screen.findByText("Nothing waiting")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says a refused decision once, by the shell, and the item keeps its buttons (#302)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    const photo = {
      photoId: "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01",
      accountId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
      state: "queued",
      blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
      width: 800,
      height: 1067,
      uploadedAt: "2026-09-25T12:00:00.000Z",
      checkedAt: "2026-09-25T12:00:02.000Z",
      labels: [],
      faces: 1,
      flagged: [],
      appealed: false,
      sensitive: true,
    };
    renderApp(
      staffApi("moderator", [], {
        answers: {
          "GET /admin/photos/queue": () => json({ items: [photo], total: 1 }),
          [`POST /admin/photos/${photo.photoId}/decision`]: refused,
        },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow this.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("after the bank, brings the person back to the screen the sign-in started on (#302)", async () => {
    window.sessionStorage.setItem("kuutti.admin.return", "/feedback");
    window.history.replaceState(null, "", `/#code=${"c".repeat(43)}`);
    // What main.tsx does before the router starts.
    restoreReturnPath();
    const calls: string[] = [];
    renderApp(
      staffApi("moderator", calls, { answers: { "POST /admin/auth/exchange": () => json(staff) } }),
    );
    expect(await screen.findByRole("heading", { level: 2, name: "Feedback" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/feedback");
    expect(window.location.hash).toBe("");
    expect(calls).toContain("POST /admin/auth/exchange");
    expect(calls).not.toContain("GET /admin/photos/queue");
  });

  it("offers a skip link to the screen, first on the page (#302)", async () => {
    renderApp(async () => json(health));
    const skip = screen.getAllByRole("link")[0];
    expect(skip).toHaveTextContent("Skip to content");
    expect(skip).toHaveAttribute("href", "#main");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
    await screen.findByRole("button", { name: "Sign in with your bank" });
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
