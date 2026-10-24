import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setRoleAnswerHandler, setTokenSource } from "../../lib/api.ts";
import { ReportQueue } from "./ReportQueue.tsx";

// The report queue as a moderator reads it (#311): one box per person
// reported, in the API's order, each report with its reason, where it was
// made, when, how long it has waited by the API's clock and "Late" in words
// and weight past the response time; both people linked to their pages with
// their histories; the decided ones behind the filter. Requests are answered
// by a fake fetch keyed on method and path.

// The API's clock, years away from the machine's: an age read off the
// browser's clock would come out wrong.
const NOW = "2031-03-09T12:00:00.000Z";
const HOUR = 3_600_000;
const before = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();

const X = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const Y = "7a2d2d5f-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const A = "1b0e0e3a-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const B = "2c1f1f4b-9a8e-4a0b-9c3a-0c8d1e2f3a4b";

const report = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a${n.toString(16).padStart(2, "0")}`,
  reason: "harassment",
  source: "card",
  createdAt: before(2 * HOUR),
  outcome: null,
  decidedAt: null,
  reporter: { accountId: A, filed: 1, upheld: 0 },
  reported: { accountId: X, received: 1, sanctions: 0 },
  ...extra,
});

const page = (items: unknown[], total = items.length, responseHours = 24) => ({
  now: NOW,
  responseHours,
  items,
  total,
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
const isList = (req: Request) =>
  req.method === "GET" && new URL(req.url).pathname === "/admin/reports";
const stateOf = (req: Request) => new URL(req.url).searchParams.get("state");
/** The open and the closed page, answered by the state asked for. */
const pages =
  (open: unknown, closed: unknown = page([])): Handler =>
  (req) =>
    isList(req) ? json(stateOf(req) === "closed" ? closed : open) : null;

function Person() {
  return <p>the page of {useParams().id}</p>;
}

function OneReport() {
  return <p>the report {useParams().id}</p>;
}

function show() {
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter initialEntries={["/reports"]}>
        <Routes>
          <Route path="/reports" element={<ReportQueue />} />
          <Route path="/accounts/:id" element={<Person />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

/** The box of one person reported, found by its heading's link. */
async function groupOf(account: string) {
  const link = await screen.findByRole("link", { name: `About account ${account.slice(0, 8)}` });
  const box = link.closest("li");
  if (!(box instanceof HTMLElement)) throw new Error(`no box for ${account}`);
  return box;
}

beforeEach(() => setTokenSource(() => "t".repeat(43)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setRoleAnswerHandler(() => undefined);
});

describe("the report queue", () => {
  it("shows the waiting reports in the API's order, a box per person reported, with both histories", async () => {
    const calls = fetchMock([
      pages(
        page([
          report(1, {
            createdAt: before(30 * HOUR),
            reporter: { accountId: A, filed: 3, upheld: 1 },
            reported: { accountId: X, received: 2, sanctions: 1 },
          }),
          report(2, {
            reason: "misrepresentation",
            source: "conversation",
            createdAt: before(2 * HOUR),
            reporter: { accountId: B, filed: 1, upheld: 0 },
            reported: { accountId: X, received: 2, sanctions: 1 },
          }),
          report(3, {
            createdAt: before(10 * HOUR),
            reported: { accountId: Y, received: 1, sanctions: 0 },
          }),
        ]),
      ),
    ]);
    show();
    expect(screen.getByRole("heading", { level: 2, name: "Reports" })).toBeInTheDocument();
    expect(screen.getByText("Loading the reports…")).toHaveAttribute("aria-busy", "true");
    expect(await screen.findByText("3 reports wait.")).toBeInTheDocument();
    expect(screen.queryByText(/Showing the first/)).toBeNull();

    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["About account 6f1c1c4e", "About account 7a2d2d5f"]);
    const x = await groupOf(X);
    expect(x).toHaveTextContent("2 reports received, 1 sanction");
    const lines = within(x).getAllByRole("listitem");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent(/^Harassment, from a card · Filed \d{1,2}\.\d{1,2}\.2031 /);
    expect(lines[0]).toHaveTextContent("Waited: 30 hours. Late (response time: 24 h)");
    expect(lines[0]).toHaveTextContent("Reported by account 1b0e0e3a · 3 reports filed, 1 upheld");
    expect(lines[1]).toHaveTextContent(/^Misrepresentation, from a conversation · Filed /);
    expect(lines[1]).toHaveTextContent("Waited: 2 hours.");
    expect(lines[1]).not.toHaveTextContent("Late");
    expect(lines[1]).toHaveTextContent("Reported by account 2c1f1f4b · 1 report filed, 0 upheld");
    const y = await groupOf(Y);
    expect(y).toHaveTextContent("1 report received, no sanctions");

    expect(calls).toHaveLength(1);
    const [first] = calls;
    expect(first && stateOf(first)).toBe("open");
    expect(first && new URL(first.url).searchParams.get("limit")).toBe("50");
    expect(first?.headers.get("authorization")).toBe(`Bearer ${"t".repeat(43)}`);
  });

  it.each([
    ["exactly at the response time", 24 * HOUR, false],
    ["a millisecond past it", 24 * HOUR + 1, true],
  ])("says Late in bold only past the response time: %s", async (_, waited, late) => {
    fetchMock([pages(page([report(1, { createdAt: before(waited) })]))]);
    show();
    const [line] = within(await groupOf(X)).getAllByRole("listitem");
    const marker = within(line as HTMLElement).queryByText("Late (response time: 24 h)");
    if (late) expect(marker?.tagName).toBe("STRONG");
    else expect(marker).toBeNull();
  });

  it.each([
    [HOUR - 1, "less than an hour"],
    [HOUR, "1 hour"],
    [47 * HOUR, "47 hours"],
    [48 * HOUR, "2 days"],
  ])("says an age of %d ms as %s, by the API's clock", async (waited, words) => {
    fetchMock([pages(page([report(1, { createdAt: before(waited) })], 1, 10_000))]);
    show();
    expect(await groupOf(X)).toHaveTextContent(`Waited: ${words}.`);
  });

  it("shows the decided ones behind the filter, with their outcomes, and keeps the focus on the filter", async () => {
    const calls = fetchMock([
      pages(
        page([report(1)]),
        page([
          report(2, { outcome: "acted", decidedAt: "2031-03-08T10:00:00.000Z" }),
          report(3, {
            outcome: "dismissed",
            decidedAt: "2031-03-01T10:00:00.000Z",
            reported: { accountId: Y, received: 1, sanctions: 0 },
          }),
        ]),
      ),
    ]);
    show();
    expect(await screen.findByText("1 report waits.")).toBeInTheDocument();
    const waiting = screen.getByRole("radio", { name: "Waiting for a decision" });
    expect(waiting).toBeChecked();
    expect(screen.getByRole("group", { name: "Show" })).toBeInTheDocument();

    const decided = screen.getByRole("radio", { name: "Decided" });
    decided.focus();
    fireEvent.click(decided);
    expect(await screen.findByText("2 reports decided.")).toBeInTheDocument();
    expect(decided).toBeChecked();
    expect(document.activeElement).toBe(decided);
    const [acted] = within(await groupOf(X)).getAllByRole("listitem");
    expect(acted).toHaveTextContent(/Acted on · Decided 8\.3\.2031 \d{2}\.\d{2}/);
    expect(within(acted as HTMLElement).getByText("Acted on").tagName).toBe("STRONG");
    expect(acted).not.toHaveTextContent("Waited");
    expect(await groupOf(Y)).toHaveTextContent(/Dismissed · Decided 1\.3\.2031/);
    expect(calls.map(stateOf)).toEqual(["open", "closed"]);

    fireEvent.click(waiting);
    expect(await screen.findByText("1 report waits.")).toBeInTheDocument();
    expect(calls.map(stateOf)).toEqual(["open", "closed", "open"]);
  });

  it("says when nothing waits or nothing was decided, and when the list holds only the first page", async () => {
    fetchMock([pages(page([]), page([report(1)], 120))]);
    show();
    expect(await screen.findByText("Nothing waits.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Decided" }));
    expect(
      await screen.findByText("120 reports decided. Showing the first 1 of them."),
    ).toBeInTheDocument();
    cleanup();

    fetchMock([pages(page([]), page([]))]);
    show();
    fireEvent.click(await screen.findByRole("radio", { name: "Decided" }));
    expect(await screen.findByText("No report has been decided yet.")).toBeInTheDocument();
  });

  it("reloads on refresh", async () => {
    let answered = 0;
    fetchMock([
      (req) => (isList(req) ? json(answered++ === 0 ? page([]) : page([report(1)])) : null),
    ]);
    show();
    expect(await screen.findByText("Nothing waits.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("1 report waits.")).toBeInTheDocument();
    expect(await groupOf(X)).toBeInTheDocument();
  });

  it.each([
    ["an error answer", () => json({ error: { code: "internal_error" } }, 500)],
    ["an answer that is not the contract", () => json({ items: "none" })],
  ])("says when the list could not be loaded: %s", async (_, answer) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock([(req) => (isList(req) ? answer() : null)]);
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The reports could not be loaded. Try Refresh.",
    );
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
  });

  it("leaves a refusal to the shell: no failure of its own and no list (#302)", async () => {
    const answers: boolean[] = [];
    setRoleAnswerHandler((allowed) => answers.push(allowed));
    fetchMock([(req) => (isList(req) ? json({ error: { code: "admin_forbidden" } }, 403) : null)]);
    show();
    await waitFor(() => expect(answers).toEqual([false]));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Loading the reports…")).toBeNull();
    expect(screen.queryByText(/wait/)).toBeNull();
  });

  it("links each report to its own page, one link per report, named by its first line (#312)", async () => {
    fetchMock([
      pages(
        page([
          report(1),
          report(2, { reason: "scraping", source: "conversation" }),
          report(3, { reported: { accountId: Y, received: 1, sanctions: 0 } }),
        ]),
      ),
    ]);
    render(
      <I18nProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/reports"]}>
          <Routes>
            <Route path="/reports" element={<ReportQueue />} />
            <Route path="/reports/:id" element={<OneReport />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );
    const lines = within(await groupOf(X)).getAllByRole("listitem");
    const links = lines.map((line) =>
      within(line)
        .getAllByRole("link")
        .filter((link) => link.getAttribute("href")?.startsWith("/reports/")),
    );
    expect(links.map((found) => found.length)).toEqual([1, 1]);
    const [first, second] = links.map(([link]) => link as HTMLElement);
    expect(first).toHaveAttribute("href", `/reports/${report(1).id}`);
    expect(first?.textContent).toMatch(/^Harassment, from a card · Filed /);
    expect(first).toHaveClass("target");
    expect(second).toHaveAttribute("href", `/reports/${report(2).id}`);
    expect(second?.textContent).toMatch(/^Scraping, from a conversation · Filed /);
    expect(
      screen
        .getAllByRole("link")
        .filter((link) => link.getAttribute("href")?.startsWith("/reports/")),
    ).toHaveLength(3);
    fireEvent.click(second as HTMLElement);
    expect(await screen.findByText(`the report ${report(2).id}`)).toBeInTheDocument();
  });

  it.each([
    ["the person reported", `About account ${X.slice(0, 8)}`, X],
    ["the reporter", `Reported by account ${A.slice(0, 8)}`, A],
  ])("links %s to their page", async (_, name, account) => {
    fetchMock([pages(page([report(1)]))]);
    show();
    const link = await screen.findByRole("link", { name });
    expect(link).toHaveAttribute("href", `/accounts/${account}`);
    fireEvent.click(link);
    expect(await screen.findByText(`the page of ${account}`)).toBeInTheDocument();
  });
});
