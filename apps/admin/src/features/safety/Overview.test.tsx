import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setRoleAnswerHandler, setTokenSource } from "../../lib/api.ts";
import { Overview } from "./Overview.tsx";

// The panel's front page as a moderator reads it (#303): one line per queue,
// a link to its screen, how many wait and how long the oldest has, measured
// by the API's clock and never the browser's, and "Late" in words and weight
// once the oldest is past the response time. Requests are answered by a fake
// fetch keyed on method and path.

// The API's clock, years away from the machine's: an age read off the
// browser's clock would come out wrong in every case below.
const NOW = "2031-03-09T12:00:00.000Z";
const HOUR = 3_600_000;
/** An instant `ms` before the API's now. */
const before = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();

type Queue = {
  queue: "reports" | "photos" | "feedback";
  waiting: number;
  oldestSince: string | null;
};
const empty = (queue: Queue["queue"]): Queue => ({ queue, waiting: 0, oldestSince: null });
const overview = (queues: Queue[], responseHours = 24, now = NOW) => ({
  now,
  responseHours,
  queues,
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
const isOverview = (req: Request) => req.method === "GET" && path(req) === "/admin/overview";
const answer =
  (body: unknown, status = 200): Handler =>
  (req) =>
    isOverview(req) ? json(body, status) : null;

/** The front page at "/", and stand-ins for the screens its links open. */
function show() {
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/reports" element={<p>the report screen</p>} />
          <Route path="/photos" element={<p>the photo screen</p>} />
          <Route path="/feedback" element={<p>the feedback screen</p>} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

/** The line of one queue, found by its link's name. */
async function lineOf(name: string) {
  const link = await screen.findByRole("link", { name });
  const line = link.closest("li");
  if (!line) throw new Error(`no line for ${name}`);
  return line;
}

beforeEach(() => setTokenSource(() => "t".repeat(43)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setRoleAnswerHandler(() => undefined);
});

describe("the front page", () => {
  it("says it is loading until the API answers, then one line per queue in the API's order", async () => {
    let release: (res: Response) => void = () => undefined;
    const calls = fetchMock([
      (req) => (isOverview(req) ? new Promise<Response>((r) => (release = r)) : null),
    ]);
    show();
    expect(screen.getByRole("heading", { level: 2, name: "What waits" })).toBeInTheDocument();
    expect(screen.getByText("Loading what waits…")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("list")).toBeNull();

    // The request is out before it is answered.
    await waitFor(() => expect(calls).toHaveLength(1));
    release(
      json(
        overview([
          { queue: "feedback", waiting: 1, oldestSince: before(2 * HOUR) },
          { queue: "photos", waiting: 3, oldestSince: before(5 * HOUR) },
        ]),
      ),
    );
    const lines = await screen.findAllByRole("listitem");
    expect(screen.queryByText("Loading what waits…")).toBeNull();
    expect(lines.map((line) => line.textContent)).toEqual([
      "Feedback 1 waits. Oldest: 2 hours",
      "Photo review queue 3 wait. Oldest: 5 hours",
    ]);
    expect(screen.queryByText("Nothing waits in any queue.")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${"t".repeat(43)}`);
  });

  it.each([
    ["Reports", "/reports", "the report screen"],
    ["Photo review queue", "/photos", "the photo screen"],
    ["Feedback", "/feedback", "the feedback screen"],
  ])("links %s to its screen at %s", async (name, href, screenText) => {
    fetchMock([
      answer(
        overview([
          { queue: "reports", waiting: 1, oldestSince: before(HOUR) },
          { queue: "photos", waiting: 2, oldestSince: before(HOUR) },
          { queue: "feedback", waiting: 4, oldestSince: before(HOUR) },
        ]),
      ),
    ]);
    show();
    const link = await screen.findByRole("link", { name });
    expect(link).toHaveAttribute("href", href);
    fireEvent.click(link);
    expect(await screen.findByText(screenText)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "What waits" })).toBeNull();
  });

  it("makes every link a 44 pt target the keyboard reaches, an empty queue's too", async () => {
    fetchMock([
      answer(
        overview([{ queue: "photos", waiting: 1, oldestSince: before(HOUR) }, empty("feedback")]),
      ),
    ]);
    show();
    await screen.findAllByRole("listitem");
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Photo review queue", "Feedback"]);
    for (const link of links) {
      expect(link).toHaveClass("target");
      expect(link.tabIndex).toBe(0);
      link.focus();
      expect(link).toHaveFocus();
    }
  });

  it("says nothing waits after an empty queue, and only there", async () => {
    fetchMock([
      answer(
        overview([empty("photos"), { queue: "feedback", waiting: 2, oldestSince: before(HOUR) }]),
      ),
    ]);
    show();
    expect(await lineOf("Photo review queue")).toHaveTextContent(
      /^Photo review queue nothing waits\.$/,
    );
    expect(await lineOf("Feedback")).toHaveTextContent(/^Feedback 2 wait\. Oldest: 1 hour$/);
    expect(screen.queryByText("Nothing waits in any queue.")).toBeNull();
    expect(screen.queryByText(/Late/)).toBeNull();
  });

  it("says nothing waits in any queue when every queue is empty, each line still linking to it", async () => {
    fetchMock([answer(overview([empty("photos"), empty("feedback")]))]);
    show();
    expect(await screen.findByText("Nothing waits in any queue.")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((line) => line.textContent)).toEqual([
      "Photo review queue nothing waits.",
      "Feedback nothing waits.",
    ]);
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.queryByText(/Late/)).toBeNull();
  });

  it("says nothing waits in any queue when the API names no queue at all", async () => {
    fetchMock([answer(overview([]))]);
    show();
    expect(await screen.findByText("Nothing waits in any queue.")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.queryByRole("link")).toBeNull();
  });

  describe("measures the oldest's age by the API's clock, in the coarsest unit that says it", () => {
    it.each([
      ["less than an hour", 0],
      ["less than an hour", HOUR - 1],
      ["1 hour", HOUR],
      ["1 hour", 2 * HOUR - 1],
      ["2 hours", 2 * HOUR],
      ["47 hours", 47 * HOUR],
      ["47 hours", 48 * HOUR - 1],
      ["2 days", 48 * HOUR],
      ["2 days", 72 * HOUR - 1],
      ["3 days", 72 * HOUR],
      ["9 days", 9 * 24 * HOUR],
      ["9 days", 10 * 24 * HOUR - 1],
    ])("says %s after %d ms", async (age, ms) => {
      // A response time no age here reaches: "Late" stays out of the line.
      fetchMock([
        answer(overview([{ queue: "photos", waiting: 1, oldestSince: before(ms) }], 10_000)),
      ]);
      show();
      expect(await lineOf("Photo review queue")).toHaveTextContent(
        new RegExp(`^Photo review queue 1 waits\\. Oldest: ${age}$`),
      );
    });

    it("reads the age off the API's now even when that is behind the browser's clock", async () => {
      const past = "2020-01-01T12:00:00.000Z";
      fetchMock([
        answer(
          overview(
            [{ queue: "feedback", waiting: 1, oldestSince: "2020-01-01T09:00:00.000Z" }],
            24,
            past,
          ),
        ),
      ]);
      show();
      expect(await lineOf("Feedback")).toHaveTextContent(/Oldest: 3 hours$/);
      expect(screen.queryByText(/Late/)).toBeNull();
    });
  });

  describe("says late, in words and in bold, only once the oldest is past the response time", () => {
    it("is not late a millisecond before the line, nor exactly at it", async () => {
      fetchMock([
        answer(
          overview([
            { queue: "photos", waiting: 1, oldestSince: before(24 * HOUR - 1) },
            { queue: "feedback", waiting: 1, oldestSince: before(24 * HOUR) },
          ]),
        ),
      ]);
      show();
      expect(await lineOf("Photo review queue")).toHaveTextContent(/Oldest: 23 hours$/);
      expect(await lineOf("Feedback")).toHaveTextContent(/Oldest: 24 hours$/);
      expect(screen.queryByText(/Late/)).toBeNull();
      expect(document.querySelector("strong")).toBeNull();
    });

    it("is late a millisecond past the line, on that queue's line alone", async () => {
      fetchMock([
        answer(
          overview([
            { queue: "photos", waiting: 2, oldestSince: before(24 * HOUR + 1) },
            { queue: "feedback", waiting: 1, oldestSince: before(HOUR) },
          ]),
        ),
      ]);
      show();
      const photos = await lineOf("Photo review queue");
      expect(photos).toHaveTextContent(
        /^Photo review queue 2 wait\. Oldest: 24 hours Late \(response time: 24 h\)$/,
      );
      const late = within(photos).getByText("Late (response time: 24 h)");
      expect(late.tagName).toBe("STRONG");
      expect(await lineOf("Feedback")).not.toHaveTextContent(/Late/);
      expect(screen.getAllByText(/Late/)).toHaveLength(1);
    });

    it("names the response time the API sends, and measures by it", async () => {
      fetchMock([
        answer(
          overview(
            [
              { queue: "photos", waiting: 1, oldestSince: before(36 * HOUR) },
              { queue: "feedback", waiting: 1, oldestSince: before(9 * 24 * HOUR) },
            ],
            36,
          ),
        ),
      ]);
      show();
      // Thirty-six hours is not late against a thirty-six hour line.
      expect(await lineOf("Photo review queue")).toHaveTextContent(/Oldest: 36 hours$/);
      const feedback = await lineOf("Feedback");
      expect(feedback).toHaveTextContent(/Oldest: 9 days Late \(response time: 36 h\)$/);
      expect(within(feedback).getByText("Late (response time: 36 h)").tagName).toBe("STRONG");
    });

    it("is never late for an empty queue, even with no response time to spare", async () => {
      fetchMock([answer(overview([empty("photos"), empty("feedback")], 0))]);
      show();
      expect(await screen.findByText("Nothing waits in any queue.")).toBeInTheDocument();
      expect(screen.queryByText(/Late/)).toBeNull();
    });
  });

  it("says the page could not be loaded when the API fails", async () => {
    fetchMock([answer({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500)]);
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("What waits could not be loaded.");
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText("Loading what waits…")).toBeNull();
  });

  it("says the page could not be loaded when the answer is not the contract, and logs why", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // A queue the panel does not know, and a count below zero.
    fetchMock([
      answer({
        now: NOW,
        responseHours: 24,
        queues: [{ queue: "reports", waiting: -1, oldestSince: null }],
      }),
    ]);
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("What waits could not be loaded.");
    expect(log).toHaveBeenCalledWith("overview load failed", expect.anything());
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("says the page could not be loaded when the network fails, and logs why", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock([
      (req) => {
        if (isOverview(req)) throw new TypeError("Failed to fetch");
        return null;
      },
    ]);
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("What waits could not be loaded.");
    expect(log).toHaveBeenCalledWith("overview load failed", expect.any(TypeError));
  });

  it("leaves a refusal to the shell: a 403 shows nothing of its own (#302)", async () => {
    const role = vi.fn();
    setRoleAnswerHandler(role);
    fetchMock([answer({ error: { code: "admin_forbidden", message: "x", requestId: "r" } }, 403)]);
    show();
    await waitFor(() => expect(role).toHaveBeenCalledWith(false));
    await waitFor(() => expect(screen.queryByText("Loading what waits…")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("What waits could not be loaded.")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText("Nothing waits in any queue.")).toBeNull();
    // The heading and the refresh stay, for when the role is given back.
    expect(screen.getByRole("heading", { level: 2, name: "What waits" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  });

  it("reloads on refresh, from what it said before to what waits now", async () => {
    const answers = [
      () => json(overview([empty("photos"), empty("feedback")])),
      () =>
        json(
          overview([
            { queue: "photos", waiting: 5, oldestSince: before(30 * HOUR) },
            empty("feedback"),
          ]),
        ),
    ];
    let pending: (res: Response) => void = () => undefined;
    const calls = fetchMock([
      (req) => {
        if (!isOverview(req)) return null;
        const next = answers.shift();
        // The third answer waits, so the refresh's loading state can be seen.
        return next ? next() : new Promise<Response>((r) => (pending = r));
      },
    ]);
    show();
    expect(await screen.findByText("Nothing waits in any queue.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await lineOf("Photo review queue")).toHaveTextContent(
      /^Photo review queue 5 wait\. Oldest: 30 hours Late \(response time: 24 h\)$/,
    );
    expect(screen.queryByText("Nothing waits in any queue.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Loading what waits…")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
    await waitFor(() => expect(calls.filter(isOverview)).toHaveLength(3));
    pending(json(overview([empty("photos"), empty("feedback")])));
    expect(await screen.findByText("Nothing waits in any queue.")).toBeInTheDocument();
  });

  it("recovers on refresh after a failure", async () => {
    let fail = true;
    fetchMock([
      (req) =>
        isOverview(req)
          ? fail
            ? json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500)
            : json(overview([empty("photos"), empty("feedback")]))
          : null,
    ]);
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("What waits could not be loaded.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Nothing waits in any queue.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
