import { formatDateTime } from "@kuutti/i18n";
import { I18nProvider } from "@kuutti/i18n/react";
import { type AutomaticBan, Sanction } from "@kuutti/schema";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setRoleAnswerHandler, setTokenSource } from "../../lib/api.ts";
import { AutomaticBans } from "./AutomaticBans.tsx";

// The automatic shadow bans as a moderator works them (#105): each rule's
// ban in the API's order, the rule in words from its counts and times, how
// long the person has been hidden by the API's clock and "Late" in words and
// weight past the review time; Confirm and Reverse each open #307's second
// look with the decision fixed and nothing preset, and a decision takes the
// line off the list and says so where the focus goes. Requests are answered
// by a fake fetch keyed on method and path.

// The API's clock, years away from the machine's: an age read off the
// browser's clock would come out wrong.
const NOW = "2031-03-09T12:00:00.000Z";
const HOUR = 3_600_000;
const before = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const when = (at: string) => formatDateTime("en", new Date(at));

const hex = (n: number) => n.toString(16).padStart(2, "0");
const sanctionId = (n: number) => `5a1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a${hex(n)}`;
const accountOf = (n: number) => `${hex(n)}1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b`;
const STAFF = "a1b2c3d4-9a8e-4a0b-9c3a-0c8d1e2f3a99";
const TEXT = "Three reports in an hour, all about the same lines";

/** A rule's ban: three people's reports, the ban two hours old, unless told otherwise. */
const ban = (n: number, extra: Partial<AutomaticBan> = {}): AutomaticBan => ({
  id: sanctionId(n),
  accountId: accountOf(n),
  rule: "reports",
  count: 3,
  firstAt: before(30 * HOUR),
  createdAt: before(2 * HOUR),
  ...extra,
});
const queue = (items: AutomaticBan[], total = items.length, reviewHours = 48) => ({
  now: NOW,
  reviewHours,
  items,
  total,
});
/** What the review route answers: the sanction, kept or lifted, with the reviewer's note. */
const reviewed = (item: AutomaticBan, outcome: "keep" | "lift") =>
  Sanction.parse({
    id: item.id,
    accountId: item.accountId,
    kind: "shadow_ban",
    reason: "other",
    note: "Applied by an automatic rule.",
    endsAt: null,
    createdBy: null,
    createdAt: item.createdAt,
    liftedAt: outcome === "lift" ? NOW : null,
    liftedBy: outcome === "lift" ? STAFF : null,
    reviewNote: TEXT,
    reviewedBy: STAFF,
    reviewedAt: NOW,
  });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const failure = (status: number, code: string) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);

type Answer = () => Promise<Response> | Response;
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
/** Answers one method and path: each call the next answer, the last one again after that. */
const on = (method: string, route: string, ...answers: Answer[]): Handler => {
  let n = 0;
  return (req) => {
    if (req.method !== method || path(req) !== route) return null;
    const answer = answers[Math.min(n, answers.length - 1)];
    n += 1;
    return answer ? answer() : null;
  };
};

const LIST = "/admin/sanctions/automatic";
const reviewRoute = (item: AutomaticBan) => `/admin/sanctions/${item.id}/review`;
/** The list's answers in turn: the first read, then each read again. */
const listOf = (...pages: unknown[]) => on("GET", LIST, ...pages.map((page) => () => json(page)));
const asked = (calls: Request[]) => calls.map((c) => `${c.method} ${path(c)}`);
const bodyOf = async (req: Request | undefined) => {
  const text = await req?.clone().text();
  return text ? JSON.parse(text) : null;
};

function Person() {
  return <p>the page of {useParams().id}</p>;
}

function show() {
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter initialEntries={["/automatic-bans"]}>
        <Routes>
          <Route path="/automatic-bans" element={<AutomaticBans />} />
          <Route path="/accounts/:id" element={<Person />} />
          <Route path="/reports" element={<p>the report screen</p>} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

const linkName = (item: AutomaticBan) => `Account ${item.accountId.slice(0, 8)}`;
/** One ban's line, found by its link to the person; waits for the list. */
async function lineOf(item: AutomaticBan) {
  const link = await screen.findByRole("link", { name: linkName(item) });
  const line = link.closest("li");
  if (!line) throw new Error(`no line for ${item.id}`);
  return line;
}
/** A line's paragraphs: the link's heading aside, the rule and the time hidden. */
const lines = (line: HTMLElement) => [...line.querySelectorAll("p")].map((p) => p.textContent);

/** Presses a line's button as a keyboard does, so it has the focus a dialog gives back. */
async function press(name: "Confirm" | "Reverse", item: AutomaticBan) {
  const button = within(await lineOf(item)).getByRole("button", { name });
  button.focus();
  fireEvent.click(button);
  return { button, dialog: screen.getByRole("dialog") };
}
const NOTE = "Your note";
const noteIn = (dialog: HTMLElement) => within(dialog).getByRole("textbox", { name: NOTE });

const reportsWords = (item: AutomaticBan) =>
  `3 people reported this account between ${when(item.firstAt)} and ${when(item.createdAt)}.`;
const CONFIRM_EFFECT =
  "The person stays hidden from everyone else, and what they send stays withheld, until somebody lifts it. They are not told. The reports filed before it can then be closed with it, one by one.";
const REVERSE_EFFECT =
  "The person is seen again at once, unless something else still open hides them, and what they sent while hidden reaches the people they wrote to. They are not told.";

beforeEach(() => setTokenSource(() => "t".repeat(43)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setRoleAnswerHandler(() => undefined);
});

describe("the automatic shadow bans", () => {
  it("says it is loading, then the review time, how many wait and each ban in the API's order, the rule in words with its times", async () => {
    let release: (res: Response) => void = () => undefined;
    const oldest = ban(1, {
      rule: "same_first_message",
      count: 12,
      firstAt: before(40 * HOUR),
      createdAt: before(30 * HOUR),
    });
    const middle = ban(2, {
      rule: "first_messages",
      count: 40,
      firstAt: before(26 * HOUR),
      createdAt: before(5 * HOUR),
    });
    const newest = ban(3);
    const calls = fetchMock([
      (req) =>
        req.method === "GET" && path(req) === LIST
          ? new Promise<Response>((r) => (release = r))
          : null,
    ]);
    show();
    expect(
      screen.getByRole("heading", { level: 2, name: "Automatic shadow bans" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Loading the automatic shadow bans…")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.queryByRole("list")).toBeNull();
    await waitFor(() => expect(calls).toHaveLength(1));
    release(json(queue([oldest, middle, newest])));

    expect(await screen.findByText("3 automatic shadow bans wait.")).toHaveAttribute(
      "aria-live",
      "polite",
    );
    expect(screen.queryByText("Loading the automatic shadow bans…")).toBeNull();
    expect(
      screen.getByText(
        "A rule hid these people from everyone else, and they are not told. Confirm or reverse each within 48 hours. Past that the shadow ban stays as it is, and says Late.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Showing the first/)).toBeNull();
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items.map((item) => within(item).getByRole("link").textContent)).toEqual([
      linkName(oldest),
      linkName(middle),
      linkName(newest),
    ]);
    expect(lines(await lineOf(oldest))).toEqual([
      `Sent the same first message to 12 people between ${when(oldest.firstAt)} and ${when(oldest.createdAt)}.`,
      "Hidden: 30 hours.",
    ]);
    expect(lines(await lineOf(middle))).toEqual([
      `Sent the first message of 40 conversations between ${when(middle.firstAt)} and ${when(middle.createdAt)}.`,
      "Hidden: 5 hours.",
    ]);
    expect(lines(await lineOf(newest))).toEqual([reportsWords(newest), "Hidden: 2 hours."]);
    // None is past the review time: the explanation names Late, no line says it.
    expect(screen.queryByText(/Late \(/)).toBeNull();
    expect(document.querySelector("strong")).toBeNull();
    // Asked once, with the moderator's token, and nothing else.
    expect(asked(calls)).toEqual([`GET ${LIST}`]);
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${"t".repeat(43)}`);
  });

  it.each<[AutomaticBan["rule"], number, string]>([
    ["reports", 1, "1 person reported this account"],
    ["reports", 2, "2 people reported this account"],
    ["first_messages", 1, "Sent the first message of 1 conversation"],
    ["first_messages", 2, "Sent the first message of 2 conversations"],
    ["same_first_message", 1, "Sent the same first message to 1 person"],
    ["same_first_message", 2, "Sent the same first message to 2 people"],
  ])("says the %s rule's count of %d as %s", async (rule, count, words) => {
    const item = ban(1, { rule, count });
    fetchMock([listOf(queue([item]))]);
    show();
    expect(lines(await lineOf(item))[0]).toBe(
      `${words} between ${when(item.firstAt)} and ${when(item.createdAt)}.`,
    );
  });

  it("says Late in words and bold a millisecond past the review time by the API's clock, and not at exactly it", async () => {
    const onTime = ban(1, { createdAt: before(48 * HOUR) });
    const late = ban(2, { createdAt: before(48 * HOUR + 1) });
    fetchMock([listOf(queue([late, onTime]))]);
    show();
    expect(lines(await lineOf(onTime))[1]).toBe("Hidden: 2 days.");
    const lateLine = await lineOf(late);
    expect(lines(lateLine)[1]).toBe("Hidden: 2 days. Late (response time: 48 h)");
    expect(within(lateLine).getByText("Late (response time: 48 h)").tagName).toBe("STRONG");
    expect(screen.getAllByText(/Late \(/)).toHaveLength(1);
  });

  it("names and measures by the review time the API sends", async () => {
    const item = ban(1, { createdAt: before(12 * HOUR + 1) });
    fetchMock([listOf(queue([item], 1, 12))]);
    show();
    expect(
      await screen.findByText(/Confirm or reverse each within 12 hours\./),
    ).toBeInTheDocument();
    expect(lines(await lineOf(item))[1]).toBe("Hidden: 12 hours. Late (response time: 12 h)");
  });

  it("says a one-hour review time in the singular", async () => {
    fetchMock([listOf(queue([], 0, 1))]);
    show();
    expect(await screen.findByText(/Confirm or reverse each within 1 hour\./)).toBeInTheDocument();
  });

  it("links each person to their page as a 44 pt target, and describes each button by what the rule counted", async () => {
    const item = ban(7);
    fetchMock([listOf(queue([item]))]);
    show();
    const line = await lineOf(item);
    const link = within(line).getByRole("link", { name: linkName(item) });
    expect(link).toHaveClass("target");
    expect(link.closest("h3")).not.toBeNull();
    const buttons = within(line).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Confirm", "Reverse"]);
    // Whose ban, then what the rule counted.
    for (const button of buttons) {
      expect(button).toHaveAccessibleDescription(`${linkName(item)} ${reportsWords(item)}`);
    }
    fireEvent.click(link);
    expect(await screen.findByText(`the page of ${item.accountId}`)).toBeInTheDocument();
  });

  it("says how many wait in all, and how many are shown, when more wait than the first page holds", async () => {
    fetchMock([listOf(queue([ban(1), ban(2)], 150))]);
    show();
    expect(
      await screen.findByText("150 automatic shadow bans wait. Showing the first 2 of them."),
    ).toBeInTheDocument();
  });

  it("says none waits when the list is empty, with no line and no button but Refresh", async () => {
    fetchMock([listOf(queue([]))]);
    show();
    expect(await screen.findByText("No automatic shadow ban waits.")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Refresh"]);
  });

  it("says the list could not be loaded when the API fails", async () => {
    fetchMock([on("GET", LIST, () => failure(500, "internal_error"))]);
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The automatic shadow bans could not be loaded. Try Refresh.",
    );
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText(/Confirm or reverse/)).toBeNull();
  });

  it("says the list could not be loaded when the answer is not the contract, and logs why", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // A rule the panel does not know.
    fetchMock([listOf({ ...queue([]), items: [{ ...ban(1), rule: "likes" }], total: 1 })]);
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The automatic shadow bans could not be loaded. Try Refresh.",
    );
    expect(log).toHaveBeenCalledWith("automatic bans load failed", expect.anything());
  });

  it("leaves a refusal to the shell: a 403 shows nothing of its own (#302)", async () => {
    const role = vi.fn();
    setRoleAnswerHandler(role);
    fetchMock([on("GET", LIST, () => failure(403, "admin_forbidden"))]);
    show();
    await waitFor(() => expect(role).toHaveBeenCalledWith(false));
    await waitFor(() =>
      expect(screen.queryByText("Loading the automatic shadow bans…")).toBeNull(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText(/wait/)).toBeNull();
    // The heading and the refresh stay, for when the role is given back.
    expect(screen.getByRole("heading", { level: 2, name: "Automatic shadow bans" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  });

  it("reloads on refresh, from what it said before to what waits now", async () => {
    const item = ban(1);
    const calls = fetchMock([listOf(queue([]), queue([item]))]);
    show();
    expect(await screen.findByText("No automatic shadow ban waits.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("1 automatic shadow ban waits.")).toBeInTheDocument();
    expect(await lineOf(item)).toBeInTheDocument();
    expect(asked(calls)).toEqual([`GET ${LIST}`, `GET ${LIST}`]);
  });
});

describe("confirming or reversing an automatic shadow ban", () => {
  it("confirms with no choice preset: the step says the effect, needs a note, sends keep and its trimmed note, then the line goes and the status links to the reports", async () => {
    const first = ban(1, { createdAt: before(5 * HOUR) });
    const second = ban(2);
    const calls = fetchMock([
      listOf(queue([first, second])),
      on("POST", reviewRoute(second), () => json(reviewed(second, "keep"))),
    ]);
    show();
    const { dialog } = await press("Confirm", second);
    expect(
      screen.getByRole("dialog", {
        name: `Confirm the automatic shadow ban on account ${second.accountId.slice(0, 8)}`,
      }),
    ).toBe(dialog);
    // The step says what the rule counted before what confirming does.
    expect(
      within(dialog).getByText(`${reportsWords(second)} ${CONFIRM_EFFECT}`),
    ).toBeInTheDocument();
    // The button pressed is the decision: no choice to make again, none preset.
    expect(within(dialog).queryAllByRole("radio")).toHaveLength(0);
    expect(within(dialog).queryByRole("group")).toBeNull();
    const note = noteIn(dialog);
    expect(note).toHaveFocus();
    expect(note).toBeRequired();
    expect(note).toHaveAccessibleDescription("Characters: 0/500");
    const send = within(dialog).getByRole("button", { name: "Confirm" });
    expect(send).toBeDisabled();
    fireEvent.change(note, { target: { value: "   " } });
    expect(send).toBeDisabled();
    fireEvent.change(note, { target: { value: `  ${TEXT}  ` } });
    expect(send).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();

    fireEvent.click(send);
    const status = screen.getByRole("status");
    await waitFor(() =>
      expect(status).toHaveTextContent(
        `Confirmed: the shadow ban on account ${second.accountId.slice(0, 8)} stays. The reports filed before it can now be closed with it, one by one. Open the reports`,
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    // The line and its buttons are gone: the status line has the focus.
    await waitFor(() => expect(status).toHaveFocus());
    expect(screen.queryByRole("link", { name: linkName(second) })).toBeNull();
    expect(await lineOf(first)).toBeInTheDocument();
    expect(screen.getByText("1 automatic shadow ban waits.")).toBeInTheDocument();
    expect(asked(calls)).toEqual([`GET ${LIST}`, `POST ${reviewRoute(second)}`]);
    expect(await bodyOf(calls[1])).toEqual({ note: TEXT, outcome: "keep" });

    const reports = within(status).getByRole("link", { name: "Open the reports" });
    expect(reports).toHaveClass("target");
    expect(reports).toHaveAttribute("href", "/reports");
    fireEvent.click(reports);
    expect(await screen.findByText("the report screen")).toBeInTheDocument();
  });

  it("reverses: the step says the effect, sends lift, then the line goes and the status says the person is seen again", async () => {
    const item = ban(4, { rule: "first_messages", count: 25 });
    const calls = fetchMock([
      listOf(queue([item])),
      on("POST", reviewRoute(item), () => json(reviewed(item, "lift"))),
    ]);
    show();
    const { dialog } = await press("Reverse", item);
    expect(
      screen.getByRole("dialog", {
        name: `Reverse the automatic shadow ban on account ${item.accountId.slice(0, 8)}`,
      }),
    ).toBe(dialog);
    expect(
      within(dialog).getByText(
        `Sent the first message of 25 conversations between ${when(item.firstAt)} and ${when(item.createdAt)}. ${REVERSE_EFFECT}`,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryAllByRole("radio")).toHaveLength(0);
    const send = within(dialog).getByRole("button", { name: "Reverse" });
    expect(send).toBeDisabled();
    fireEvent.change(noteIn(dialog), { target: { value: TEXT } });
    fireEvent.click(send);

    const status = screen.getByRole("status");
    await waitFor(() =>
      expect(status).toHaveTextContent(
        `Reversed: the automatic shadow ban on account ${item.accountId.slice(0, 8)} is lifted.`,
      ),
    );
    await waitFor(() => expect(status).toHaveFocus());
    expect(within(status).queryByRole("link")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText("No automatic shadow ban waits.")).toBeInTheDocument();
    expect(asked(calls)).toEqual([`GET ${LIST}`, `POST ${reviewRoute(item)}`]);
    expect(await bodyOf(calls[1])).toEqual({ note: TEXT, outcome: "lift" });
  });

  it("clears the last decision's status when the next step opens, and says the next one where the focus goes", async () => {
    const first = ban(1);
    const second = ban(2);
    fetchMock([
      listOf(queue([first, second])),
      on("POST", reviewRoute(first), () => json(reviewed(first, "keep"))),
      on("POST", reviewRoute(second), () => json(reviewed(second, "lift"))),
    ]);
    show();
    const one = (await press("Confirm", first)).dialog;
    fireEvent.change(noteIn(one), { target: { value: TEXT } });
    fireEvent.click(within(one).getByRole("button", { name: "Confirm" }));
    const status = screen.getByRole("status");
    await waitFor(() => expect(status).toHaveTextContent(/^Confirmed:/));

    const two = (await press("Reverse", second)).dialog;
    expect(status).toBeEmptyDOMElement();
    // Opened afresh: the last step's note is not kept.
    expect(noteIn(two)).toHaveValue("");
    fireEvent.change(noteIn(two), { target: { value: TEXT } });
    fireEvent.click(within(two).getByRole("button", { name: "Reverse" }));
    await waitFor(() => expect(status).toHaveTextContent(/^Reversed:/));
    await waitFor(() => expect(status).toHaveFocus());
    expect(screen.getByText("No automatic shadow ban waits.")).toBeInTheDocument();
  });

  it.each(["Cancel", "Escape"])(
    "%s closes the step with nothing sent, the focus back on the button and the line kept",
    async (how) => {
      const item = ban(1);
      const calls = fetchMock([listOf(queue([item]))]);
      show();
      const { button, dialog } = await press("Reverse", item);
      fireEvent.change(noteIn(dialog), { target: { value: TEXT } });
      if (how === "Cancel") fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      else fireEvent.keyDown(noteIn(dialog), { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(button).toHaveFocus();
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
      expect(await lineOf(item)).toBeInTheDocument();
      expect(screen.getByText("1 automatic shadow ban waits.")).toBeInTheDocument();
      expect(asked(calls)).toEqual([`GET ${LIST}`]);
    },
  );

  it("sends nothing when the step's form is submitted with no note", async () => {
    const item = ban(1);
    const calls = fetchMock([listOf(queue([item]))]);
    show();
    const { dialog } = await press("Confirm", item);
    fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(asked(calls)).toEqual([`GET ${LIST}`]);
  });

  it.each<[string, number, string]>([
    ["sanction_reviewed", 409, "Somebody looked at it again already."],
    ["sanction_lifted", 409, "It is lifted already."],
    ["own_account", 409, "This is about your own account: somebody else decides."],
    ["not_found", 404, "It is not there any more."],
    ["internal_error", 500, "It could not be done. Try again."],
  ])("says the refusal %s in words in the step, the line kept", async (code, status, words) => {
    const item = ban(1);
    const calls = fetchMock([
      listOf(queue([item])),
      on("POST", reviewRoute(item), () => failure(status, code)),
    ]);
    show();
    const { dialog } = await press("Confirm", item);
    fireEvent.change(noteIn(dialog), { target: { value: TEXT } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(words);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(await lineOf(item)).toBeInTheDocument();
    expect(screen.getByText("1 automatic shadow ban waits.")).toBeInTheDocument();
    expect(asked(calls)).toEqual([`GET ${LIST}`, `POST ${reviewRoute(item)}`]);
  });

  it("leaves a refused decision to the shell: the step closes with no words of its own, the line kept (#302)", async () => {
    const role = vi.fn();
    setRoleAnswerHandler(role);
    const item = ban(1);
    fetchMock([
      listOf(queue([item])),
      on("POST", reviewRoute(item), () => failure(403, "admin_forbidden")),
    ]);
    show();
    const { button, dialog } = await press("Reverse", item);
    fireEvent.change(noteIn(dialog), { target: { value: TEXT } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reverse" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(role).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(button).toHaveFocus();
    expect(await lineOf(item)).toBeInTheDocument();
  });
});
