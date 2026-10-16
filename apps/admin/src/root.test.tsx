import { act, cleanup, screen } from "@testing-library/react";
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
