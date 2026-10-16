import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setTokenSource } from "../../lib/api.ts";
import { FeedbackList } from "./FeedbackList.tsx";

// The feedback list as a moderator uses it (#171): the rows in the API's
// order with their kind, words and build, marked handled one by one; every
// request carries the admin token. Requests are answered by a fake fetch
// keyed on method and path.

const item = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a${n.toString(16).padStart(2, "0")}`,
  accountId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  kind: "bug",
  text: `A few lines, number ${n}.`,
  appVersion: "0.22.0",
  platform: "ios",
  locale: "fi",
  createdAt: "2026-10-15T12:00:00.000Z",
  handledAt: null,
  ...extra,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Handler = (req: Request) => Promise<Response> | Response | null;
function fetchMock(handlers: Handler[]) {
  const calls: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      calls.push(req);
      for (const handler of handlers) {
        const res = await handler(req);
        if (res) return res;
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    }),
  );
  return calls;
}
const path = (req: Request) => new URL(req.url).pathname;
const listOf =
  (items: unknown[], total = items.length): Handler =>
  (req) =>
    req.method === "GET" && path(req) === "/admin/feedback" ? json({ items, total }) : null;
const handledOk: Handler = (req) =>
  req.method === "POST" && /\/admin\/feedback\/[^/]+\/handled$/.test(path(req))
    ? json({ id: path(req).split("/")[3], handledAt: "2026-10-15T13:00:00.000Z" })
    : null;

function show() {
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter>
        <FeedbackList />
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => setTokenSource(() => "t".repeat(43)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the feedback list", () => {
  it("lists the rows in the API's order with their kind, words and build, and marks one handled", async () => {
    const calls = fetchMock([
      listOf([item(1), item(2, { kind: "praise", platform: "android", locale: "sv" })], 7),
      handledOk,
    ]);
    show();
    expect(await screen.findByText("7 waiting.")).toBeTruthy();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Bug", "Praise"]);
    expect(screen.getByText("A few lines, number 1.")).toBeTruthy();
    expect(screen.getByText(/Version 0\.22\.0, android, sv · .* · account 6f1c1c4e/)).toBeTruthy();
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${"t".repeat(43)}`);

    const [first] = screen.getAllByRole("button", { name: "Mark as handled" });
    if (!first) throw new Error("no button");
    fireEvent.click(first);
    await waitFor(() => expect(screen.getByText("Handled.")).toBeTruthy());
    const marked = calls.find((c) => c.method === "POST");
    expect(marked && path(marked)).toBe(`/admin/feedback/${item(1).id}/handled`);
    expect(screen.getByText("6 waiting.")).toBeTruthy();
    expect(screen.queryByText("A few lines, number 1.")).toBeNull();
    expect(screen.getByText("A few lines, number 2.")).toBeTruthy();
  });

  it("says when nothing waits, and reloads on refresh", async () => {
    let page = 0;
    fetchMock([
      (req) =>
        req.method === "GET" && path(req) === "/admin/feedback"
          ? json(page++ === 0 ? { items: [], total: 0 } : { items: [item(3)], total: 1 })
          : null,
    ]);
    show();
    expect(await screen.findByText("Nothing waiting.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("1 waiting.")).toBeTruthy();
    expect(screen.getByText("A few lines, number 3.")).toBeTruthy();
  });

  it("says when the list could not be loaded, and when marking did not work", async () => {
    fetchMock([
      (req) =>
        req.method === "GET" && path(req) === "/admin/feedback"
          ? json({ error: { code: "internal_error" } }, 500)
          : null,
    ]);
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("The feedback could not be loaded.");
    cleanup();

    fetchMock([
      listOf([item(4)]),
      (req) => (req.method === "POST" ? json({ error: { code: "internal_error" } }, 500) : null),
    ]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Mark as handled" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Marking did not work.");
    expect(screen.getByText("A few lines, number 4.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark as handled" })).toBeTruthy();
  });

  it("leaves a refused marking to the shell: the row keeps its button and says nothing of its own (#302)", async () => {
    fetchMock([
      listOf([item(6)]),
      (req) =>
        req.method === "POST"
          ? json({ error: { code: "admin_forbidden", message: "x", requestId: "r" } }, 403)
          : null,
    ]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Mark as handled" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Mark as handled" })).toBeEnabled(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("A few lines, number 6.")).toBeInTheDocument();
  });

  it("says marking did not work when the network fails, and lets the moderator try again", async () => {
    fetchMock([
      listOf([item(5)]),
      (req) => {
        if (req.method === "POST") throw new TypeError("Failed to fetch");
        return null;
      },
    ]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Mark as handled" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Marking did not work.");
    expect(screen.getByRole("button", { name: "Mark as handled" })).toBeEnabled();
  });
});
