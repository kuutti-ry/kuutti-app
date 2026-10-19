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

/** The front page's answer (#303): every queue empty, by the API's clock. */
const overview = {
  now: "2026-09-25T12:00:00.000Z",
  responseHours: 24,
  queues: [
    { queue: "photos", waiting: 0, oldestSince: null },
    { queue: "feedback", waiting: 0, oldestSince: null },
  ],
};

/** A person's page (#306): an account with nothing on it yet. */
const accountId = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const account = {
  id: accountId,
  state: "registered",
  stateChangedAt: null,
  registeredAt: "2026-09-25T10:00:00.000Z",
  deletedAt: null,
  standing: "ok",
  standingChangedAt: null,
  suspensionEndsAt: null,
  age: null,
  gender: null,
  pond: null,
  profile: null,
  photos: [],
  feedback: [],
  audit: [],
};
const accountAnswers = {
  [`GET /admin/accounts/${accountId}`]: () => json(account),
  [`GET /admin/accounts/${accountId}/sanctions`]: () => json({ items: [] }),
};

/** One report (#312): a card's, waiting, with no note. */
const reportId = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01";
const reportAnswers = {
  [`GET /admin/reports/${reportId}`]: () =>
    json({
      id: reportId,
      reason: "harassment",
      source: "card",
      createdAt: "2026-09-25T10:00:00.000Z",
      outcome: null,
      decidedAt: null,
      reporter: { accountId: accountId, filed: 1, upheld: 0 },
      reported: { accountId: "7a2d2d5f-9a8e-4a0b-9c3a-0c8d1e2f3a4b", received: 1, sanctions: 0 },
      note: null,
      decidedBy: null,
      sanctionId: null,
      copy: null,
      actable: [],
    }),
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
    if (key === "GET /admin/overview") return json(overview);
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

  it("signed in as a moderator, names the role and the session's end and opens the front page (#303)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    renderApp(staffApi());
    expect(await screen.findByText(/Signed in as moderator/)).toHaveTextContent(
      `Session ends: ${formatTime("en", new Date(staff.expiresAt))}`,
    );
    expect(
      await screen.findByRole("heading", { level: 2, name: "What waits" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Nothing waits in any queue.")).toBeInTheDocument();
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
    expect(screen.queryByRole("heading", { name: "What waits" })).toBeNull();
    expect(calls).not.toContain("GET /admin/overview");
    expect(calls).not.toContain("GET /admin/photos/queue");
    expect(calls).not.toContain("GET /admin/feedback");
  });

  it("a session revoked while the panel is open goes back to the sign-in, saying so (#250)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    window.history.replaceState(null, "", "/photos");
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

  it("opens the overview at the front page, first in the menu and marked current only there (#302, #303)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    const calls: string[] = [];
    renderApp(staffApi("moderator", calls));
    const front = await screen.findByRole("heading", { level: 2, name: "What waits" });
    expect(window.location.pathname).toBe("/");
    const menu = screen.getByRole("navigation", { name: "Screens" });
    const links = within(menu).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Overview",
      "Reports",
      "Photos",
      "Feedback",
      "A person",
    ]);
    expect(within(menu).getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/");
    expect(within(menu).getByRole("link", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(menu).getByRole("link", { name: "Photos" })).not.toHaveAttribute("aria-current");
    expect(within(menu).getByRole("link", { name: "Feedback" })).not.toHaveAttribute(
      "aria-current",
    );
    // Loading the panel is not the person's move: nothing takes the focus.
    expect(front).not.toHaveFocus();
    expect(document.title).toBe("What waits · Kuutti admin");
    expect(await screen.findByText("Nothing waits in any queue.")).toBeInTheDocument();
    expect(calls).toContain("GET /admin/overview");
    expect(calls).not.toContain("GET /admin/photos/queue");
    expect(calls).not.toContain("GET /admin/feedback");

    // Every path starts with "/": the overview is current at "/" alone, not under another screen.
    fireEvent.click(within(menu).getByRole("link", { name: "Photos" }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Photo review queue" }),
    ).toBeInTheDocument();
    expect(within(menu).getByRole("link", { name: "Photos" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(menu).getByRole("link", { name: "Overview" })).not.toHaveAttribute(
      "aria-current",
    );

    // And back again by the menu: the overview's heading takes the focus.
    fireEvent.click(within(menu).getByRole("link", { name: "Overview" }));
    const again = await screen.findByRole("heading", { level: 2, name: "What waits" });
    expect(window.location.pathname).toBe("/");
    await waitFor(() => expect(again).toHaveFocus());
    expect(within(menu).getByRole("link", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(menu).getByRole("link", { name: "Photos" })).not.toHaveAttribute("aria-current");
  });

  it("opens a queue from its line on the front page, its heading taking the focus (#303)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    const calls: string[] = [];
    renderApp(staffApi("moderator", calls));
    await screen.findByText("Nothing waits in any queue.");
    fireEvent.click(screen.getByRole("link", { name: "Photo review queue" }));
    const heading = await screen.findByRole("heading", { level: 2, name: "Photo review queue" });
    expect(window.location.pathname).toBe("/photos");
    await waitFor(() => expect(heading).toHaveFocus());
    expect(calls).toContain("GET /admin/photos/queue");
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

  it("offers an admin the tunables in the menu, and the screen loads them (#304)", async () => {
    window.sessionStorage.setItem(
      "kuutti.admin.session",
      JSON.stringify({ ...staff, role: "admin" }),
    );
    const calls: string[] = [];
    renderApp(
      staffApi("admin", calls, { answers: { "GET /admin/config": () => json({ items: [] }) } }),
    );
    const menu = await screen.findByRole("navigation", { name: "Screens" });
    expect(
      within(menu)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual([
      "Overview",
      "Reports",
      "Photos",
      "Feedback",
      "A person",
      "Tunables",
      "Audit log",
      "Staff",
    ]);
    expect(calls).not.toContain("GET /admin/config");
    fireEvent.click(within(menu).getByRole("link", { name: "Tunables" }));
    const heading = await screen.findByRole("heading", { level: 2, name: "Tunables" });
    expect(window.location.pathname).toBe("/config");
    await waitFor(() => expect(heading).toHaveFocus());
    expect(within(menu).getByRole("link", { name: "Tunables" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(await screen.findByText("0 tunables")).toBeInTheDocument();
    expect(calls).toContain("GET /admin/config");
    expect(document.title).toBe("Tunables · Kuutti admin");
  });

  it("opens the tunables from their own address for an admin (#304)", async () => {
    window.sessionStorage.setItem(
      "kuutti.admin.session",
      JSON.stringify({ ...staff, role: "admin" }),
    );
    window.history.replaceState(null, "", "/config");
    const calls: string[] = [];
    renderApp(
      staffApi("admin", calls, { answers: { "GET /admin/config": () => json({ items: [] }) } }),
    );
    expect(await screen.findByRole("heading", { level: 2, name: "Tunables" })).toBeInTheDocument();
    expect(await screen.findByText("0 tunables")).toBeInTheDocument();
    expect(calls).toContain("GET /admin/config");
    expect(calls).not.toContain("GET /admin/photos/queue");
    expect(screen.queryByText("Your role does not allow this.")).toBeNull();
  });

  it("shows a moderator no tunables in the menu, and at their address says the role does not allow it, asking nothing (#304)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    window.history.replaceState(null, "", "/config");
    const calls: string[] = [];
    renderApp(staffApi("moderator", calls));
    const heading = await screen.findByRole("heading", { level: 2, name: "Tunables" });
    expect(heading).not.toHaveFocus();
    expect(screen.getByText("Your role does not allow this.")).toBeInTheDocument();
    // Said where it is asked for, not as a refusal the API answered.
    expect(screen.queryByRole("alert")).toBeNull();
    const menu = screen.getByRole("navigation", { name: "Screens" });
    expect(
      within(menu)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Overview", "Reports", "Photos", "Feedback", "A person"]);
    expect(within(menu).queryByRole("link", { name: "Tunables" })).toBeNull();
    expect(screen.queryByText("Loading the tunables…")).toBeNull();
    expect(document.title).toBe("Tunables · Kuutti admin");
    // The menu still works from here, and the panel never asked for the tunables.
    fireEvent.click(within(menu).getByRole("link", { name: "Feedback" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Feedback" })).toBeInTheDocument();
    expect(calls).toContain("GET /admin/feedback");
    expect(calls).not.toContain("GET /admin/config");
  });

  it("offers an admin the audit log and the staff in the menu, each screen asking for its own when opened (#309, #310)", async () => {
    window.sessionStorage.setItem(
      "kuutti.admin.session",
      JSON.stringify({ ...staff, role: "admin" }),
    );
    const calls: string[] = [];
    renderApp(
      staffApi("admin", calls, {
        answers: {
          "GET /admin/audit": () => json({ items: [], next: null }),
          "GET /admin/staff": () => json({ items: [] }),
        },
      }),
    );
    const menu = await screen.findByRole("navigation", { name: "Screens" });
    expect(calls).not.toContain("GET /admin/audit");
    expect(calls).not.toContain("GET /admin/staff");

    fireEvent.click(within(menu).getByRole("link", { name: "Audit log" }));
    const audit = await screen.findByRole("heading", { level: 2, name: "Audit log" });
    expect(window.location.pathname).toBe("/audit");
    await waitFor(() => expect(audit).toHaveFocus());
    expect(within(menu).getByRole("link", { name: "Audit log" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(await screen.findByText("Nothing matches.")).toBeInTheDocument();
    expect(calls).toContain("GET /admin/audit");
    expect(calls).not.toContain("GET /admin/staff");
    expect(document.title).toBe("Audit log · Kuutti admin");

    fireEvent.click(within(menu).getByRole("link", { name: "Staff" }));
    const staffHeading = await screen.findByRole("heading", { level: 2, name: "Staff" });
    expect(window.location.pathname).toBe("/staff");
    await waitFor(() => expect(staffHeading).toHaveFocus());
    expect(within(menu).getByRole("link", { name: "Staff" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(menu).getByRole("link", { name: "Audit log" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(await screen.findByText("0 members of staff")).toBeInTheDocument();
    expect(calls).toContain("GET /admin/staff");
    expect(document.title).toBe("Staff · Kuutti admin");
    expect(screen.queryByText("Your role does not allow this.")).toBeNull();
  });

  it.each([
    ["/audit", "Audit log"],
    ["/staff", "Staff"],
  ])(
    "shows a moderator no audit log or staff in the menu, and at %s says the role does not allow it, asking nothing (#309, #310)",
    async (address, title) => {
      window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
      window.history.replaceState(null, "", address);
      const calls: string[] = [];
      renderApp(staffApi("moderator", calls));
      const heading = await screen.findByRole("heading", { level: 2, name: title });
      expect(heading).not.toHaveFocus();
      expect(screen.getByText("Your role does not allow this.")).toBeInTheDocument();
      // Said where it is asked for, not as a refusal the API answered.
      expect(screen.queryByRole("alert")).toBeNull();
      const menu = screen.getByRole("navigation", { name: "Screens" });
      expect(
        within(menu)
          .getAllByRole("link")
          .map((link) => link.textContent),
      ).toEqual(["Overview", "Reports", "Photos", "Feedback", "A person"]);
      expect(within(menu).queryByRole("link", { name: "Audit log" })).toBeNull();
      expect(within(menu).queryByRole("link", { name: "Staff" })).toBeNull();
      expect(screen.queryByRole("form", { name: "Filters" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
      expect(document.title).toBe(`${title} · Kuutti admin`);
      // The menu still works from here, and the panel asked for neither screen.
      fireEvent.click(within(menu).getByRole("link", { name: "Feedback" }));
      expect(
        await screen.findByRole("heading", { level: 2, name: "Feedback" }),
      ).toBeInTheDocument();
      expect(calls).toContain("GET /admin/feedback");
      expect(calls).not.toContain("GET /admin/audit");
      expect(calls).not.toContain("GET /admin/staff");
    },
  );

  it("opens the way to a person's page from the menu, and a pasted id opens the page, each heading taking the focus (#306)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    const calls: string[] = [];
    renderApp(staffApi("moderator", calls, { answers: accountAnswers }));
    const menu = await screen.findByRole("navigation", { name: "Screens" });
    fireEvent.click(within(menu).getByRole("link", { name: "A person" }));
    const lookup = await screen.findByRole("heading", { level: 2, name: "A person's page" });
    expect(window.location.pathname).toBe("/accounts");
    await waitFor(() => expect(lookup).toHaveFocus());
    expect(within(menu).getByRole("link", { name: "A person" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(document.title).toBe("A person's page · Kuutti admin");
    expect(calls.filter((call) => call.includes("/admin/accounts"))).toEqual([]);

    fireEvent.change(screen.getByLabelText("Account id"), { target: { value: accountId } });
    fireEvent.click(screen.getByRole("button", { name: "Open the page" }));
    const page = await screen.findByRole("heading", { level: 2, name: "Account 6f1c1c4e" });
    expect(window.location.pathname).toBe(`/accounts/${accountId}`);
    await waitFor(() => expect(page).toHaveFocus());
    expect(await screen.findByText("No profile yet.")).toBeInTheDocument();
    expect(calls).toContain(`GET /admin/accounts/${accountId}`);
    expect(calls).toContain(`GET /admin/accounts/${accountId}/sanctions`);
    // The page itself is no entry of the menu.
    expect(within(menu).getAllByRole("link", { name: "A person" })).toHaveLength(1);
  });

  it("opens a person's page from its own address, outside the menu and without taking the focus (#306)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    window.history.replaceState(null, "", `/accounts/${accountId}`);
    const calls: string[] = [];
    renderApp(staffApi("moderator", calls, { answers: accountAnswers }));
    const heading = await screen.findByRole("heading", { level: 2, name: "Account 6f1c1c4e" });
    expect(heading).not.toHaveFocus();
    expect(await screen.findByText("No profile yet.")).toBeInTheDocument();
    expect(document.title).toBe("Account 6f1c1c4e · Kuutti admin");
    const menu = screen.getByRole("navigation", { name: "Screens" });
    expect(
      within(menu)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Overview", "Reports", "Photos", "Feedback", "A person"]);
    expect(screen.queryByText("Nothing at this address")).toBeNull();
    expect(calls).toContain(`GET /admin/accounts/${accountId}`);
    expect(calls).not.toContain("GET /admin/overview");
  });

  it.each([
    ["an admin", "admin", ["Warn", "Hide from others (shadow ban)", "Suspend until a day", "Ban"]],
    ["a moderator", "moderator", ["Warn", "Hide from others (shadow ban)", "Suspend until a day"]],
  ])(
    "gives the signed-in role to a person's page: %s sees these actions (#308)",
    async (_who, role, actions) => {
      window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify({ ...staff, role }));
      window.history.replaceState(null, "", `/accounts/${accountId}`);
      renderApp(staffApi(role, [], { answers: accountAnswers }));
      const group = await screen.findByRole("group", { name: "Actions on this person" });
      expect(
        within(group)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(actions);
      expect(screen.getByText(new RegExp(`Signed in as ${role}`))).toBeInTheDocument();
    },
  );

  it("says a refused person's page once, by the shell, never as the page's failure (#302, #306)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    window.history.replaceState(null, "", `/accounts/${accountId}`);
    const calls: string[] = [];
    renderApp(
      staffApi("moderator", calls, {
        answers: { [`GET /admin/accounts/${accountId}`]: refused },
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow this.");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText("The page could not be loaded.")).toBeNull();
    expect(screen.queryByText("No account has this id.")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Account 6f1c1c4e" })).toBeInTheDocument();
    expect(calls).not.toContain(`GET /admin/accounts/${accountId}/sanctions`);
  });

  it("opens a report from its own address, outside the menu, asking for it once (#312)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    window.history.replaceState(null, "", `/reports/${reportId}`);
    const calls: string[] = [];
    renderApp(staffApi("moderator", calls, { answers: reportAnswers }));
    const heading = await screen.findByRole("heading", { level: 2, name: "Report 0b1c1c4e" });
    expect(heading).not.toHaveFocus();
    expect(await screen.findByText("No note.")).toBeInTheDocument();
    expect(document.title).toBe("Report 0b1c1c4e · Kuutti admin");
    const menu = screen.getByRole("navigation", { name: "Screens" });
    expect(
      within(menu)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Overview", "Reports", "Photos", "Feedback", "A person"]);
    expect(calls.filter((call) => call.includes("/admin/reports"))).toEqual([
      `GET /admin/reports/${reportId}`,
    ]);
  });

  it("says a refused report once, by the shell, never as the page's failure (#302, #312)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    window.history.replaceState(null, "", `/reports/${reportId}`);
    renderApp(
      staffApi("moderator", [], { answers: { [`GET /admin/reports/${reportId}`]: refused } }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow this.");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText("No such report.")).toBeNull();
    expect(screen.queryByText("The report could not be loaded.")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Report 0b1c1c4e" })).toBeInTheDocument();
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
      await screen.findByRole("heading", { level: 2, name: "What waits" }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
    expect(await screen.findByText("Nothing waits in any queue.")).toBeInTheDocument();
  });

  it("says once that the role does not allow it when the API answers 403, never as the screen's failure, and not again once the role is honoured (#302)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    window.history.replaceState(null, "", "/photos");
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

  it("says a refused front page once, by the shell, never as the overview's failure (#302, #303)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    renderApp(staffApi("moderator", [], { answers: { "GET /admin/overview": refused } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow this.");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText("What waits could not be loaded.")).toBeNull();
    expect(screen.queryByText("Loading what waits…")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "What waits" })).toBeInTheDocument();
  });

  it("does not bring a refusal back when the person returns to the screen it was said on (#302)", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    window.history.replaceState(null, "", "/photos");
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
    window.history.replaceState(null, "", "/photos");
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
    expect(calls).not.toContain("GET /admin/overview");
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
