import { act, cleanup, screen, within } from "@testing-library/react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "./root.tsx";

// The panel mounted into the page (#302): the remembered path is put back
// before the router reads the address, so the bank's return lands on the
// screen the sign-in started on and the front page's screen is never asked for.

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const staff = {
  accessToken: "a".repeat(43),
  expiresAt: "2030-01-01T08:00:00.000Z",
  role: "moderator",
};

let root: Root | undefined;
let element: HTMLElement | undefined;

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  act(() => root?.unmount());
  element?.remove();
  root = undefined;
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("mount", () => {
  it("puts the remembered path back before the router starts, and exchanges the code there", async () => {
    window.sessionStorage.setItem("kuutti.admin.return", "/feedback");
    window.history.replaceState(null, "", `/#code=${"c".repeat(43)}`);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const key = `${req.method} ${new URL(req.url).pathname}`;
        calls.push(key);
        if (key === "POST /admin/auth/exchange") return json(staff);
        if (key === "GET /admin/feedback") return json({ items: [], total: 0 });
        if (key === "GET /health") return json({ status: "ok" });
        throw new Error(`unexpected ${key}`);
      }),
    );
    element = document.createElement("div");
    document.body.append(element);
    await act(async () => {
      root = mount(element as HTMLElement);
    });
    expect(await screen.findByRole("heading", { level: 2, name: "Feedback" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/feedback");
    expect(window.location.hash).toBe("");
    expect(calls).toContain("POST /admin/auth/exchange");
    expect(calls).not.toContain("GET /admin/photos/queue");
  });
});

// A preview (ADR-025 §6): the panel built with Vite's base /pr-<n>/ and served
// under it, against the staging API. The router's basename is the base without
// its last slash, so the preview's own address opens it with or without one,
// and its links stay inside the preview.
describe("mount under a preview's base", () => {
  /** A signed-in moderator's API, recording what was asked. */
  function signedIn(calls: string[]) {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(staff));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const key = `${req.method} ${new URL(req.url).pathname}`;
        calls.push(key);
        if (key === "GET /admin/whoami") {
          return json({ role: "moderator", expiresAt: staff.expiresAt });
        }
        if (key === "GET /admin/overview") {
          // A whole AdminOverview, so the front page renders rather than logging a parse failure.
          const none = { here: 0, elsewhere: 0, other: 0 };
          return json({
            now: "2026-09-25T12:00:00.000Z",
            responseHours: 24,
            reviewHours: 48,
            queues: [],
            foundThem: { days: 30, recent: none, allTime: none },
          });
        }
        if (key === "GET /admin/feedback") return json({ items: [], total: 0 });
        if (key === "GET /health") return json({ status: "ok" });
        throw new Error(`unexpected ${key}`);
      }),
    );
  }

  async function mountAt(path: string) {
    vi.stubEnv("BASE_URL", "/pr-7/");
    window.history.replaceState(null, "", path);
    element = document.createElement("div");
    document.body.append(element);
    await act(async () => {
      root = mount(element as HTMLElement);
    });
  }

  it("opens a page of the preview at its path under the base", async () => {
    const calls: string[] = [];
    signedIn(calls);
    await mountAt("/pr-7/feedback");
    expect(await screen.findByRole("heading", { level: 2, name: "Feedback" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/pr-7/feedback");
    expect(calls).toContain("GET /admin/feedback");
    expect(calls).not.toContain("GET /admin/overview");
  });

  it.each([
    ["without its last slash", "/pr-7"],
    ["with it", "/pr-7/"],
  ])(
    "opens the front page at the preview's own address %s, its links inside the preview",
    async (_, path) => {
      const calls: string[] = [];
      signedIn(calls);
      await mountAt(path);
      expect(
        await screen.findByRole("heading", { level: 2, name: "What waits" }),
      ).toBeInTheDocument();
      expect(calls).toContain("GET /admin/overview");
      const menu = screen.getByRole("navigation", { name: "Screens" });
      expect(within(menu).getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/pr-7");
      expect(within(menu).getByRole("link", { name: "Feedback" })).toHaveAttribute(
        "href",
        "/pr-7/feedback",
      );
    },
  );
});
