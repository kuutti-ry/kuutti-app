import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { SignIn } from "./SignIn.tsx";
import { readFragment, StaffSessionProvider, useStaffSession } from "./session.tsx";

// The staff session in the browser (#49): the code from the fragment is
// exchanged once and the fragment is consumed; a refusal is shown; a stored
// session is checked with the API before it is trusted.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const session = {
  accessToken: "a".repeat(43),
  expiresAt: "2030-01-01T08:00:00.000Z",
  role: "moderator",
};

function Probe() {
  const state = useStaffSession();
  return (
    <p data-testid="state">
      {state.status}
      {state.status === "signed-in" ? ` ${state.session.role}` : ""}
    </p>
  );
}

function show(strict = false) {
  const tree = (
    <I18nProvider i18n={i18n}>
      <StaffSessionProvider>
        <Probe />
        <SignIn />
      </StaffSessionProvider>
    </I18nProvider>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("staff session", () => {
  it("reads a code or an error from the fragment and nothing from anything else", () => {
    expect(readFragment("#code=abc")).toEqual({ code: "abc" });
    expect(readFragment("#error=admin_not_allowed")).toEqual({ error: "admin_not_allowed" });
    expect(readFragment("")).toEqual({});
    expect(readFragment("#other=1")).toEqual({});
  });

  it("exchanges the code from the fragment once, consumes the fragment and keeps the session", async () => {
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        calls.push(req);
        return json(session);
      }),
    );
    window.history.replaceState(null, "", `/#code=${"c".repeat(43)}`);
    show();
    await waitFor(() =>
      expect(screen.getByTestId("state")).toHaveTextContent("signed-in moderator"),
    );
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/admin/auth/exchange");
    expect(JSON.parse(await (calls[0] as Request).text())).toEqual({ code: "c".repeat(43) });
    expect(window.location.hash).toBe("");
    expect(JSON.parse(window.sessionStorage.getItem("kuutti.admin.session") ?? "{}")).toMatchObject(
      { role: "moderator" },
    );
  });

  it("exchanges the code once under StrictMode, whose double effect must not burn it", async () => {
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        calls.push(req);
        return json(session);
      }),
    );
    window.history.replaceState(null, "", `/#code=${"d".repeat(43)}`);
    show(true);
    await waitFor(() =>
      expect(screen.getByTestId("state")).toHaveTextContent("signed-in moderator"),
    );
    expect(calls.filter((c) => new URL(c.url).pathname === "/admin/auth/exchange")).toHaveLength(1);
  });

  it("shows the refusal the fragment carried and offers the bank login", async () => {
    vi.stubGlobal("fetch", vi.fn());
    window.history.replaceState(null, "", "/#error=admin_not_allowed");
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("no moderator role");
    expect(screen.getByRole("button", { name: "Sign in with your bank" })).toBeInTheDocument();
    expect(window.location.hash).toBe("");
  });

  it("checks a stored session with the API and drops it when the API refuses", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(session));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ error: { code: "session_expired", message: "x", requestId: "r" } }, 401),
      ),
    );
    show();
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("signed-out"));
    expect(window.sessionStorage.getItem("kuutti.admin.session")).toBeNull();
  });

  it("sends the stored token with the very first request after a reload", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(session));
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        seen.push(req.headers.get("authorization") ?? "");
        return json({ role: session.role, expiresAt: session.expiresAt });
      }),
    );
    show();
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("signed-in"));
    expect(seen).toEqual([`Bearer ${session.accessToken}`]);
    expect(window.sessionStorage.getItem("kuutti.admin.session")).not.toBeNull();
  });

  it("names the refusal the exchange answered with, and keeps nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ error: { code: "admin_not_allowed", message: "x", requestId: "r" } }, 403),
      ),
    );
    window.history.replaceState(null, "", `/#code=${"e".repeat(43)}`);
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("no moderator role");
    expect(screen.getByTestId("state")).toHaveTextContent("signed-out");
    expect(window.location.hash).toBe("");
    expect(window.sessionStorage.getItem("kuutti.admin.session")).toBeNull();
  });

  it("says sign-in did not complete when the exchange fails without the error envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 })),
    );
    window.history.replaceState(null, "", `/#code=${"f".repeat(43)}`);
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sign-in did not complete. Try again.",
    );
    expect(screen.getByTestId("state")).toHaveTextContent("signed-out");
  });

  it("is loading while the code is being exchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    window.history.replaceState(null, "", `/#code=${"g".repeat(43)}`);
    show();
    expect(screen.getByTestId("state")).toHaveTextContent("loading");
  });

  it("keeps the refusal of the fragment under StrictMode, whose second run finds the fragment gone", async () => {
    vi.stubGlobal("fetch", vi.fn());
    window.history.replaceState(null, "", "/#error=admin_not_allowed");
    show(true);
    expect(await screen.findByRole("alert")).toHaveTextContent("no moderator role");
    expect(screen.getByTestId("state")).toHaveTextContent("signed-out");
  });

  it("does not trust a stored session past its end and asks the API nothing about it", async () => {
    window.sessionStorage.setItem(
      "kuutti.admin.session",
      JSON.stringify({ ...session, expiresAt: "2026-10-01T08:00:00.000Z" }),
    );
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-01T08:00:01.000Z"));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    show();
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("signed-out"));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("treats an unreadable stored session as none", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", "{not json");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    show();
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("signed-out"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("takes the role and the end of the session from the API's answer, not from storage", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(session));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ role: "researcher", expiresAt: "2030-01-01T09:00:00.000Z" })),
    );
    show();
    await waitFor(() =>
      expect(screen.getByTestId("state")).toHaveTextContent("signed-in researcher"),
    );
  });

  it("leaves the stored session alone when the panel closes before the API answers", async () => {
    window.sessionStorage.setItem("kuutti.admin.session", JSON.stringify(session));
    let answer: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      ),
    );
    show();
    await waitFor(() => expect(answer).toBeDefined());
    cleanup();
    answer?.(json({ error: { code: "session_expired", message: "x", requestId: "r" } }, 401));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The refusal reached nobody: a closed panel neither signs out nor clears storage.
    expect(window.sessionStorage.getItem("kuutti.admin.session")).not.toBeNull();
  });

  it("keeps the session in memory when the browser refuses storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(session)),
    );
    window.history.replaceState(null, "", `/#code=${"h".repeat(43)}`);
    show();
    await waitFor(() =>
      expect(screen.getByTestId("state")).toHaveTextContent("signed-in moderator"),
    );
    expect(setItem).toHaveBeenCalled();
    expect(window.sessionStorage.getItem("kuutti.admin.session")).toBeNull();
  });

  it("refuses to be used outside its provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(
      "useStaffSession needs a StaffSessionProvider above it",
    );
  });

  it("the sign-in button sends the browser to the staff login of the API", async () => {
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
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with your bank" }));
    expect(assign).toHaveBeenCalledWith("http://localhost:3000/admin/auth/start");
  });
});
