import { formatDateTime } from "@kuutti/i18n";
import { I18nProvider } from "@kuutti/i18n/react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setTokenSource } from "../../lib/api.ts";
import { AuditLog } from "./AuditLog.tsx";

// The audit log as an admin reads it (#309): the filters sent as the API's
// query, the rows as a table, and Older and Newer walking the cursors the API
// gave. Requests are answered by a fake fetch keyed on method and path; every
// request's query is recorded as sent.

const ACTOR = "3c9d0f5e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const ACCOUNT = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const PHOTO = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01";
const AT = "2026-10-15T12:00:00.000Z";

const row = (extra: Record<string, unknown> = {}) => ({
  at: AT,
  actorIdentityId: ACTOR,
  actorRole: "moderator",
  action: "account.view",
  subjectType: "account",
  subjectId: ACCOUNT,
  accountId: ACCOUNT,
  detail: null,
  ...extra,
});
const page = (items: unknown[], next: string | null = null) => ({ items, next });
/** A page told apart from the others by its one row's detail, shown as "page n". */
const numbered = (n: number, next: string | null) =>
  page([row({ at: `2026-10-${10 + n}T12:00:00.000Z`, detail: { page: `page ${n}` } })], next);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const failure = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);

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
const isAudit = (req: Request) => req.method === "GET" && path(req) === "/admin/audit";
const queryOf = (req: Request) => Object.fromEntries(new URL(req.url).searchParams);
/** The queries the screen sent, in order. */
const sent = (calls: Request[]) => calls.filter(isAudit).map(queryOf);
const answer =
  (respond: (query: Record<string, string>) => Promise<Response> | Response): Handler =>
  (req) =>
    isAudit(req) ? respond(queryOf(req)) : null;
/** The pages by the cursor they are asked with; the first page has none. */
const pages = (byCursor: Record<string, unknown>) =>
  answer(({ before = "" }) => json(byCursor[before]));

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function show() {
  function Person() {
    return <output>{useParams().id}</output>;
  }
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter initialEntries={["/audit"]}>
        <Routes>
          <Route path="/audit" element={<AuditLog />} />
          <Route path="/accounts/:id" element={<Person />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

const filters = () => within(screen.getByRole("form", { name: "Filters" }));
function fill(values: Partial<Record<string, string>>) {
  for (const [label, value] of Object.entries(values)) {
    fireEvent.change(filters().getByLabelText(label), { target: { value } });
  }
  fireEvent.click(filters().getByRole("button", { name: "Show" }));
}
const older = () => screen.getByRole("button", { name: "Older" });
const newer = () => screen.getByRole("button", { name: "Newer" });
const shown = () => screen.findByRole("table");

beforeEach(() => setTokenSource(() => "t".repeat(43)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the audit log", () => {
  it("is busy while a page loads, with no table and no paging", async () => {
    const second = deferred<Response>();
    fetchMock([answer(({ before }) => (before ? second.promise : json(numbered(1, "c1"))))]);
    show();
    expect(screen.getByText("Loading the audit log…")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "Older" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Newer" })).toBeNull();
    await shown();
    expect(screen.queryByText("Loading the audit log…")).toBeNull();

    fireEvent.click(older());
    expect(await screen.findByText("Loading the audit log…")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    second.resolve(json(numbered(2, null)));
    expect(await screen.findByText("page 2")).toBeInTheDocument();
    expect(screen.queryByText("Loading the audit log…")).toBeNull();
  });

  it("asks for the first page with no filter and the admin's token", async () => {
    const calls = fetchMock([pages({ "": page([row()]) })]);
    show();
    await shown();
    expect(calls).toHaveLength(1);
    expect(new URL((calls[0] as Request).url).search).toBe("");
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${"t".repeat(43)}`);
  });

  it("shows every row in a table under its caption, newest first as the API gave them", async () => {
    fetchMock([
      pages({
        "": page([
          row({
            action: "sanction.apply",
            detail: { reason: "spam", days: 7, final: false, note: null },
          }),
          row({
            at: "2026-10-14T08:05:00.000Z",
            actorRole: null,
            action: "photo.view",
            subjectType: "photo",
            subjectId: PHOTO,
          }),
        ]),
      }),
    ]);
    show();
    const table = await shown();
    expect(within(table).getByText("Newest first, fifty a page")).toBeInTheDocument();
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["When", "Who", "Role now", "What", "Subject", "Detail"]);
    const rows = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((tr) =>
        within(tr)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      );
    expect(rows).toEqual([
      [
        formatDateTime("en", new Date(AT)),
        ACTOR,
        "moderator",
        "sanction.apply",
        "account 6f1c1c4e",
        "reasonspamdays7finalfalsenote–",
      ],
      [
        formatDateTime("en", new Date("2026-10-14T08:05:00.000Z")),
        ACTOR,
        "None now",
        "photo.view",
        "photo 0b1c1c4e",
        "",
      ],
    ]);
    // The detail is key and value, a null shown as a dash.
    const detail = within(table).getAllByRole("row")[1]?.lastElementChild as HTMLElement;
    expect(
      within(detail)
        .getAllByRole("term")
        .map((term) => term.textContent),
    ).toEqual(["reason", "days", "final", "note"]);
    expect(
      within(detail)
        .getAllByRole("definition")
        .map((value) => value.textContent),
    ).toEqual(["spam", "7", "false", "–"]);
  });

  it("names the automatic rules as who did it when no person did: a rule's shadow ban (#105)", async () => {
    fetchMock([
      pages({
        "": page([
          row({
            actorIdentityId: null,
            actorRole: null,
            action: "sanction.apply",
            detail: { rule: "reports", count: 3 },
          }),
        ]),
      }),
    ]);
    show();
    const table = await shown();
    const [cells] = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((tr) =>
        within(tr)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      );
    expect(cells?.slice(0, 4)).toEqual([
      formatDateTime("en", new Date(AT)),
      "The automatic rules",
      "Not a person",
      "sanction.apply",
    ]);
    expect(within(table).queryByText(ACTOR)).toBeNull();
  });

  it("links an account or a photo to the person's page by the whole id, and no other subject or a photo that is gone", async () => {
    fetchMock([
      pages({
        "": page([
          row({ at: "2026-10-15T12:00:03.000Z", subjectType: "photo", subjectId: PHOTO }),
          row({
            at: "2026-10-15T12:00:02.000Z",
            subjectType: "photo",
            subjectId: PHOTO,
            accountId: null,
          }),
          row({
            at: "2026-10-15T12:00:01.000Z",
            subjectType: "feedback",
            subjectId: PHOTO,
            accountId: null,
          }),
          row(),
        ]),
      }),
    ]);
    show();
    await shown();
    const links = screen.getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["photo 0b1c1c4e", `/accounts/${ACCOUNT}`],
      ["account 6f1c1c4e", `/accounts/${ACCOUNT}`],
    ]);
    fireEvent.click(links[0] as HTMLElement);
    expect(await screen.findByRole("status")).toHaveTextContent(ACCOUNT);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("holds as many rows as a page may, fifty", async () => {
    const fifty = Array.from({ length: 50 }, (_, n) =>
      row({ at: new Date(Date.UTC(2026, 9, 15, 12, 0, 59 - n)).toISOString() }),
    );
    fetchMock([pages({ "": page(fifty, "c1") })]);
    show();
    const table = await shown();
    expect(within(table).getAllByRole("row")).toHaveLength(51);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when nothing matches, and offers no paging either way", async () => {
    fetchMock([pages({ "": page([]) })]);
    show();
    expect(await screen.findByText("Nothing matches.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(newer()).toBeDisabled();
    expect(older()).toBeDisabled();
  });

  it("sends the filters as the query, trimmed, the days as the start of the from day and of the day after the to day in the browser's zone", async () => {
    const calls = fetchMock([answer(() => json(page([])))]);
    show();
    await screen.findByText("Nothing matches.");
    fill({
      "Who (identity id)": `  ${ACTOR} `,
      "What (such as sanction.apply)": " sanction.apply ",
      "Subject type (account, photo, feedback, config)": " account",
      "Subject id": `${ACCOUNT}  `,
      // Summer time begins on the one and ends on the other in Finland.
      "From day": "2026-03-29",
      "To day": "2026-10-25",
    });
    await waitFor(() => expect(sent(calls)).toHaveLength(2));
    expect(sent(calls)[1]).toEqual({
      actor: ACTOR,
      action: "sanction.apply",
      subjectType: "account",
      subjectId: ACCOUNT,
      from: new Date(2026, 2, 29).toISOString(),
      to: new Date(2026, 9, 26).toISOString(),
    });
  });

  it("leaves out a filter that is empty or only spaces, a to day alone included", async () => {
    const calls = fetchMock([answer(() => json(page([])))]);
    show();
    await screen.findByText("Nothing matches.");
    fill({
      "Who (identity id)": "   ",
      "What (such as sanction.apply)": " ",
      "Subject type (account, photo, feedback, config)": "  ",
      "Subject id": "",
      // The last day of a month: the end is the first of the next.
      "To day": "2026-02-28",
    });
    await waitFor(() => expect(sent(calls)).toHaveLength(2));
    expect(sent(calls)[1]).toEqual({ to: new Date(2026, 2, 1).toISOString() });

    fill({ "To day": "", "From day": "2026-12-31" });
    await waitFor(() => expect(sent(calls)).toHaveLength(3));
    expect(sent(calls)[2]).toEqual({ from: new Date(2026, 11, 31).toISOString() });
  });

  it("asks again only when the filters are applied, not while they are typed", async () => {
    const calls = fetchMock([answer(() => json(page([])))]);
    show();
    await screen.findByText("Nothing matches.");
    fireEvent.change(filters().getByLabelText("What (such as sanction.apply)"), {
      target: { value: "photo.view" },
    });
    expect(sent(calls)).toHaveLength(1);
    fireEvent.click(filters().getByRole("button", { name: "Show" }));
    await waitFor(() => expect(sent(calls)).toHaveLength(2));
    expect(sent(calls)[1]).toEqual({ action: "photo.view" });
  });

  it("walks older by the cursor each page gave, and newer back by the cursor before", async () => {
    const calls = fetchMock([
      pages({ "": numbered(1, "c1"), c1: numbered(2, "c2"), c2: numbered(3, null) }),
    ]);
    show();
    expect(await screen.findByText("page 1")).toBeInTheDocument();
    expect(newer()).toBeDisabled();
    expect(older()).toBeEnabled();

    fireEvent.click(older());
    expect(await screen.findByText("page 2")).toBeInTheDocument();
    expect(newer()).toBeEnabled();
    expect(older()).toBeEnabled();

    fireEvent.click(older());
    expect(await screen.findByText("page 3")).toBeInTheDocument();
    expect(newer()).toBeEnabled();
    expect(older()).toBeDisabled();

    fireEvent.click(newer());
    expect(await screen.findByText("page 2")).toBeInTheDocument();
    fireEvent.click(newer());
    expect(await screen.findByText("page 1")).toBeInTheDocument();
    expect(newer()).toBeDisabled();
    expect(sent(calls)).toEqual([{}, { before: "c1" }, { before: "c2" }, { before: "c1" }, {}]);
  });

  it("goes back to the first page when filters are applied, and pages on with them", async () => {
    const calls = fetchMock([
      answer(({ before = "", action }) =>
        json(action ? numbered(before ? 5 : 4, before ? null : "f1") : numbered(1, "c1")),
      ),
    ]);
    show();
    await screen.findByText("page 1");
    fireEvent.click(older());
    await waitFor(() => expect(sent(calls)).toHaveLength(2));
    await waitFor(() => expect(newer()).toBeEnabled());

    fill({ "What (such as sanction.apply)": "photo.view" });
    expect(await screen.findByText("page 4")).toBeInTheDocument();
    expect(newer()).toBeDisabled();
    fireEvent.click(older());
    expect(await screen.findByText("page 5")).toBeInTheDocument();
    expect(sent(calls)).toEqual([
      {},
      { before: "c1" },
      { action: "photo.view" },
      { action: "photo.view", before: "f1" },
    ]);
  });

  it("says what a valid filter is when the API refuses one, and shows the rows once it is put right", async () => {
    fetchMock([
      answer(({ actor }) =>
        actor === "someone" ? failure("validation_failed", 400) : json(page([row()])),
      ),
    ]);
    show();
    await shown();
    fill({ "Who (identity id)": "someone" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A filter is not valid: an id is a uuid, an action is two words with a dot.",
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "Older" })).toBeNull();

    fill({ "Who (identity id)": ACTOR });
    expect(await shown()).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the page of the filters last applied, even when the first page's answer arrives last", async () => {
    const first = deferred<Response>();
    fetchMock([answer(({ action }) => (action ? json(numbered(2, null)) : first.promise))]);
    show();
    fill({ "What (such as sanction.apply)": "photo.view" });
    expect(await screen.findByText("page 2")).toBeInTheDocument();
    await act(async () => first.resolve(json(numbered(1, "c1"))));
    expect(screen.queryByText("page 1")).toBeNull();
    expect(screen.getByText("page 2")).toBeInTheDocument();
    expect(older()).toBeDisabled();
  });

  it("asks again on Show with the same filters: after a failure, and for the newest rows", async () => {
    let calls = 0;
    fetchMock([
      answer(() => {
        calls += 1;
        return calls === 1 ? failure("internal_error", 500) : json(numbered(calls, null));
      }),
    ]);
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The audit log could not be loaded.",
    );
    fireEvent.click(filters().getByRole("button", { name: "Show" }));
    expect(await screen.findByText("page 2")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(filters().getByRole("button", { name: "Show" }));
    expect(await screen.findByText("page 3")).toBeInTheDocument();
    expect(calls).toBe(3);
  });

  it("gives the focus to a page reached by Older or Newer, and not to the first page", async () => {
    fetchMock([pages({ "": numbered(1, "c1"), c1: numbered(2, null) })]);
    show();
    await screen.findByText("page 1");
    expect(document.body).toHaveFocus();
    // The focus moves in the commit that shows the rows: nothing to wait for once they are there.
    fireEvent.click(older());
    const second = await screen.findByText("page 2");
    expect(second.closest('[tabindex="-1"]')).toHaveFocus();
    fireEvent.click(newer());
    const first = await screen.findByText("page 1");
    expect(first.closest('[tabindex="-1"]')).toHaveFocus();
  });

  it("gives the focus to the page Older reached when it is pressed the moment the first page shows", async () => {
    fetchMock([pages({ "": numbered(1, "c1"), c1: numbered(2, null) })]);
    // Older is pressed in the microtasks right after the commit that shows the
    // first page, before React runs that commit's effects in a task of their own.
    const watch = new MutationObserver(() => {
      if (!screen.queryByText("page 1")) return;
      watch.disconnect();
      fireEvent.click(older());
    });
    watch.observe(document.body, { childList: true, subtree: true });
    show();
    const second = await screen.findByText("page 2");
    expect(second.closest('[tabindex="-1"]')).toHaveFocus();
  });

  it("leaves a superseded request's failure unsaid: the rows of the filters applied stay", async () => {
    const first = deferred<Response>();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock([answer(({ action }) => (action ? json(numbered(2, null)) : first.promise))]);
    show();
    fill({ "What (such as sanction.apply)": "photo.view" });
    expect(await screen.findByText("page 2")).toBeInTheDocument();
    await act(async () => first.reject(new TypeError("Failed to fetch")));
    expect(screen.getByText("page 2")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(logged).not.toHaveBeenCalled();
  });

  it("says the log could not be loaded when a cursor is refused, not that a filter is wrong", async () => {
    fetchMock([
      answer(({ before }) =>
        before ? failure("cursor_invalid", 400) : json(numbered(1, "stale")),
      ),
    ]);
    show();
    await shown();
    fireEvent.click(older());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The audit log could not be loaded.",
    );
  });

  it("says the log could not be loaded when the API fails, cannot be reached, or answers outside the contract", async () => {
    const tooMany = Array.from({ length: 51 }, (_, n) =>
      row({ at: new Date(Date.UTC(2026, 9, 15, 12, 0, 59 - n)).toISOString() }),
    );
    const cases: [string, () => Response, boolean][] = [
      ["a failure", () => failure("internal_error", 500), false],
      [
        "the network",
        () => {
          throw new TypeError("Failed to fetch");
        },
        true,
      ],
      ["a row with no uuid", () => json(page([row({ subjectId: "not-a-uuid" })])), true],
      ["more rows than a page", () => json(page(tooMany, "c1")), true],
      ["no cursor at all", () => json({ items: [] }), true],
    ];
    for (const [, respond, logs] of cases) {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      fetchMock([answer(respond)]);
      show();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "The audit log could not be loaded.",
      );
      expect(screen.queryByText(/A filter is not valid/)).toBeNull();
      expect(screen.queryByText("Loading the audit log…")).toBeNull();
      expect(screen.queryByRole("table")).toBeNull();
      if (logs) expect(logged).toHaveBeenCalledWith("audit load failed", expect.anything());
      else expect(logged).not.toHaveBeenCalled();
      cleanup();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("leaves a refused log to the shell: no rows, no paging and no failure of its own (#302)", async () => {
    const calls = fetchMock([answer(() => failure("admin_forbidden", 403))]);
    show();
    await waitFor(() => expect(screen.queryByText("Loading the audit log…")).toBeNull());
    expect(screen.getByRole("heading", { level: 2, name: "Audit log" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("Nothing matches.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Older" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Newer" })).toBeNull();
    expect(sent(calls)).toEqual([{}]);
  });

  it("labels every filter, the days as dates", async () => {
    fetchMock([pages({ "": page([]) })]);
    show();
    await screen.findByText("Nothing matches.");
    for (const label of [
      "Who (identity id)",
      "What (such as sanction.apply)",
      "Subject type (account, photo, feedback, config)",
      "Subject id",
    ]) {
      expect(filters().getByLabelText(label)).toHaveAttribute("type", "text");
      expect(filters().getByLabelText(label)).toHaveValue("");
    }
    expect(filters().getByLabelText("From day")).toHaveAttribute("type", "date");
    expect(filters().getByLabelText("To day")).toHaveAttribute("type", "date");
  });
});
