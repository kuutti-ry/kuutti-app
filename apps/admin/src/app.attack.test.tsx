import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BrowserRouter } from "react-router";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { App } from "./app.tsx";
import { StaffSessionProvider } from "./features/identity/index.ts";
import { i18n } from "./i18n.ts";
import { attack } from "./test/attack.ts";
import { type Handler, held, json, network, on, settled } from "./test/network.ts";

// What goes through today (#380): a hole, which its contract forbids, and a question, where no line says what should happen.
const HOLE = "#380";
const QUESTION = "#380, a question";

// Attacks on the shell (#380, #302, #304): what each role is shown, the one
// notice of a refusal, and the session around the screens, tried the wrong
// way beside a control that does the same thing rightly.

const KEY = "kuutti.admin.session";
const staff = (role: string) => ({
  accessToken: "a".repeat(43),
  expiresAt: "2030-01-01T08:00:00.000Z",
  role,
});
const health = {
  status: "ok",
  version: "0.0.0-test",
  commit: "abc1234",
  builtAt: "2026-09-13T00:00:00.000Z",
  source: "https://codeberg.org/example/kuutti-fork",
  db: "ok",
  migrations: "current",
};
const overview = {
  now: "2026-09-25T12:00:00.000Z",
  responseHours: 24,
  reviewHours: 48,
  queues: [
    { queue: "photos", waiting: 0, oldestSince: null },
    { queue: "feedback", waiting: 0, oldestSince: null },
  ],
  foundThem: {
    days: 30,
    recent: { here: 0, elsewhere: 0, other: 0 },
    allTime: { here: 0, elsewhere: 0, other: 0 },
  },
};
const failure = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const refused = () => failure("admin_forbidden", 403);
const whoami = (role: string) => json({ role, expiresAt: staff(role).expiresAt });
const always: Handler[] = [
  on("GET", "/health", () => json(health)),
  on("GET", "/admin/overview", () => json(overview)),
];

function renderApp() {
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
const menu = () => screen.getByRole("navigation", { name: "Screens" });
const offered = (name: string) => {
  const nav = screen.queryByRole("navigation", { name: "Screens" });
  return nav !== null && within(nav).queryByRole("link", { name }) !== null;
};

async function settle() {
  for (let turn = 0; turn < 3; turn++) await settled();
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A stored session that says admin; the API's check of it still out, or answered admin. */
async function storedAdmin(check: "out" | "answered") {
  window.sessionStorage.setItem(KEY, JSON.stringify(staff("admin")));
  const answer = held();
  network([...always, on("GET", "/admin/whoami", () => answer.promise)]);
  renderApp();
  if (check === "answered") answer.answer(whoami("admin"));
  await settle();
  return offered("Tunables");
}

// session.tsx: "A stored token is checked against the API before anything is shown with it."
attack(
  "shell: an admin's screens are offered on a stored session's word while the API's check of it is out",
  {
    // Goes through today: the stored role is shown before the API has answered for it.
    open: HOLE,
    attempt: () => storedAdmin("out"),
    control: () => storedAdmin("answered"),
    succeeds: (shown) => expect(shown).toBe(true),
  },
);

async function storedAdminAnswered(role: "moderator" | "admin") {
  window.sessionStorage.setItem(KEY, JSON.stringify(staff("admin")));
  network([...always, on("GET", "/admin/whoami", () => whoami(role))]);
  renderApp();
  await screen.findByText(`Signed in as ${role}`);
  await settle();
  return offered("Tunables");
}

// rules/admin.md: a screen a role does not open is left out of the menu.
attack("shell: an admin's screens are still offered once the API says the role is moderator", {
  attempt: () => storedAdminAnswered("moderator"),
  control: () => storedAdminAnswered("admin"),
  succeeds: (shown) => expect(shown).toBe(true),
});

/**
 * An admin opens the tunables and moves to the photos before they answer; the
 * role is taken down meanwhile, so the tunables' late answer is a refusal.
 * The photo queue itself is honoured, or refused as well.
 */
async function refusedAfterLeaving(photos: "honoured" | "refused") {
  window.sessionStorage.setItem(KEY, JSON.stringify(staff("admin")));
  window.history.replaceState(null, "", "/config");
  const config = held();
  network([
    ...always,
    on("GET", "/admin/whoami", () => whoami("admin")),
    on("GET", "/admin/config", () => config.promise),
    on("GET", "/admin/photos/queue", () =>
      photos === "honoured" ? json({ items: [], total: 0 }) : refused(),
    ),
  ]);
  renderApp();
  await screen.findByRole("heading", { level: 2, name: "Tunables" });
  await settle();
  fireEvent.click(within(menu()).getByRole("link", { name: "Photos" }));
  await screen.findByRole("heading", { level: 2, name: "Photos" });
  await settle();
  config.answer(refused());
  await settle();
  return screen.queryByRole("alert")?.textContent ?? null;
}

// rules/admin.md: a 403 is said once by the shell; the notice belongs to the visit (app.tsx).
attack("shell: a refusal answered after the person left its screen is said over the next screen", {
  // Goes through today: a left screen's request is not given up, and its refusal is said wherever the person is.
  open: QUESTION,
  attempt: () => refusedAfterLeaving("honoured"),
  control: () => refusedAfterLeaving("refused"),
  succeeds: (said) => expect(said).toBe("Your role does not allow this."),
});

/** The photo queue's request is out when the person signs out, or does not; it then comes back 401. */
async function unauthorizedLate(signedOutFirst: boolean) {
  window.sessionStorage.setItem(KEY, JSON.stringify(staff("moderator")));
  window.history.replaceState(null, "", "/photos");
  const queue = held();
  network([
    ...always,
    on("GET", "/admin/whoami", () => whoami("moderator")),
    on("GET", "/admin/photos/queue", () => queue.promise),
    on("POST", "/admin/auth/logout", () => new Response(null, { status: 204 })),
  ]);
  renderApp();
  await screen.findByRole("heading", { level: 2, name: "Photos" });
  await settle();
  if (signedOutFirst) {
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("button", { name: "Sign in with your bank" });
  }
  queue.answer(failure("session_revoked", 401));
  await settle();
  return screen.queryByText("Your session has ended. Sign in again.") !== null;
}

// admin.signIn.error.session_ended: said when the API stops honouring the session "while the panel was in use".
attack(
  "shell: a 401 to a request sent before signing out tells the person who signed out that their session ended",
  {
    // Goes through today: a 401 after signing out is read as a session the API stopped honouring.
    open: QUESTION,
    attempt: () => unauthorizedLate(true),
    control: () => unauthorizedLate(false),
    succeeds: (said) => expect(said).toBe(true),
  },
);
