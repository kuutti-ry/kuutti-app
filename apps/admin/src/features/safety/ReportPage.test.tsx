import { formatDateTime } from "@kuutti/i18n";
import { I18nProvider } from "@kuutti/i18n/react";
import type { ModeratorRole } from "@kuutti/schema";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setRoleAnswerHandler, setTokenSource } from "../../lib/api.ts";
import { StaffRole } from "../../lib/role.ts";
import { ReportPage } from "./ReportPage.tsx";

// One report as a moderator works it (#312): opened once per id, its facts,
// both people, the reporter's words and the frozen conversation, a photo of
// it only on request; then a decision, by a sanction applied here, by one
// applied since the filing, or dismissed, each through its confirm step, the
// page updated in place from the answer and never read again. The page is
// rendered at its path inside the role the shell gives (StaffRole); the API
// is a fake fetch keyed on method and path, each answer in turn.

const ID = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01";
const REPORTER = "1b0e0e3a-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const REPORTED = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const STAFF = "a1b2c3d4-9a8e-4a0b-9c3a-0c8d1e2f3a99";
const sanctionId = (n: number) =>
  `5a1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a${n.toString(16).padStart(2, "0")}`;

const FILED = "2026-10-10T09:00:00.000Z";
const SAID = (minute: number) => `2026-10-09T21:${String(minute).padStart(2, "0")}:00.000Z`;
const APPLIED = "2026-10-11T08:30:00.000Z";
const DECIDED = "2026-10-12T16:20:00.000Z";
const when = (at: string) => formatDateTime("en", new Date(at));

const NOTE = "He kept writing\nafter I said no.";
const MARKUP = '<b>bold</b> <a href="https://example.com">https://example.com</a>';

/** A conversation's report, waiting: a text each way, markup sent as text, a photo held and one removed. */
const detail = (extra: Record<string, unknown> = {}) => ({
  id: ID,
  reason: "harassment",
  source: "conversation",
  createdAt: FILED,
  outcome: null,
  decidedAt: null,
  reporter: { accountId: REPORTER, filed: 3, upheld: 1 },
  reported: { accountId: REPORTED, received: 2, sanctions: 1 },
  note: NOTE,
  decidedBy: null,
  sanctionId: null,
  copy: [
    { seq: 1, side: "reporter", kind: "text", body: "Hi!", photo: false, createdAt: SAID(1) },
    { seq: 2, side: "reported", kind: "text", body: MARKUP, photo: false, createdAt: SAID(2) },
    { seq: 3, side: "reported", kind: "photo", body: null, photo: true, createdAt: SAID(3) },
    { seq: 4, side: "reporter", kind: "photo", body: null, photo: false, createdAt: SAID(4) },
  ],
  actable: [],
  ...extra,
});

/** A sanction as #307's routes answer it: a warning a moderator applied after the filing. */
const sanction = (n: number, extra: Record<string, unknown> = {}) => ({
  id: sanctionId(n),
  accountId: REPORTED,
  kind: "warn",
  reason: "harassment",
  note: "Kept writing after a no",
  endsAt: null,
  createdBy: STAFF,
  createdAt: APPLIED,
  liftedAt: null,
  liftedBy: null,
  reviewNote: null,
  reviewedBy: null,
  reviewedAt: null,
  ...extra,
});
/** One of the report's actable sanctions, as GET /admin/reports/{id} lists it. */
const actable = (n: number, extra: Record<string, unknown> = {}) => {
  const { id, kind, reason, createdAt, liftedAt } = { ...sanction(n), ...extra };
  return { id, kind, reason, createdAt, liftedAt };
};
const decision = (outcome: "dismissed" | "acted", sanctionNamed: string | null = null) => ({
  id: ID,
  outcome,
  decidedAt: DECIDED,
  decidedBy: STAFF,
  sanctionId: sanctionNamed,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const failure = (status: number, code: string) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const unreachable = (): Response => {
  throw new TypeError("Failed to fetch");
};

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
/** An answer that waits until the test lets it go. */
function held() {
  let release: (res: Response) => void = () => undefined;
  const answer = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { answer: () => answer, release: (res: Response) => release(res) };
}

const REPORT = `/admin/reports/${ID}`;
const DECISION = `${REPORT}/decision`;
const SANCTIONS = `/admin/accounts/${REPORTED}/sanctions`;
const photoOf = (seq: number) => `${REPORT}/copy/${seq}/photo`;
const photoUrl = (seq: number) => `https://media.test/media/k/${seq}/full.webp?Signature=s`;
const full = (seq: number) => () =>
  json({ url: photoUrl(seq), variant: "full", expiresAt: "2030-01-01T00:00:00.000Z" });

const theReport = (body: unknown = detail()) => on("GET", REPORT, () => json(body));
const asked = (calls: Request[]) => calls.map((c) => `${c.method} ${path(c)}`);
const bodyOf = async (req: Request | undefined) => {
  const text = await req?.clone().text();
  return text ? JSON.parse(text) : null;
};
const posted = (calls: Request[], route: string) =>
  calls.filter((c) => c.method === "POST" && path(c) === route);

function Person() {
  return <p>the page of {useParams().id}</p>;
}

function show({
  role = "moderator",
  strict = false,
}: {
  role?: ModeratorRole;
  strict?: boolean;
} = {}) {
  const screens = (
    <I18nProvider i18n={i18n}>
      <StaffRole.Provider value={role}>
        <MemoryRouter initialEntries={[`/reports/${ID}`]}>
          <Routes>
            <Route path="/reports" element={<p>the queue</p>} />
            <Route path="/reports/:id" element={<ReportPage />} />
            <Route path="/accounts/:id" element={<Person />} />
          </Routes>
        </MemoryRouter>
      </StaffRole.Provider>
    </I18nProvider>
  );
  render(strict ? <StrictMode>{screens}</StrictMode> : screens);
}

/** The value a label of the facts names. */
function termValue(term: string): string | null | undefined {
  return screen.getByText(term, { selector: "dt" }).nextElementSibling?.textContent;
}
const loaded = () => screen.findByRole("heading", { level: 3, name: "Decision" });
const ACT = "Act on the reported person";
const actions = () => screen.findByRole("group", { name: ACT });
const status = () => screen.getByRole("status");

/** Presses a button as a keyboard does, so it has the focus a dialog gives back. */
function press(button: HTMLElement) {
  button.focus();
  fireEvent.click(button);
  return screen.getByRole("dialog");
}

/** Opens Warn on the report and fills it in: its dialog and the button that sends it. */
async function warn() {
  const dialog = press(within(await actions()).getByRole("button", { name: "Warn" }));
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Reason" }), {
    target: { value: "harassment" },
  });
  fireEvent.change(within(dialog).getByRole("textbox", { name: /^Note/ }), {
    target: { value: "Kept writing after a no" },
  });
  return { dialog, send: within(dialog).getByRole("button", { name: "Apply" }) };
}

beforeEach(() => setTokenSource(() => "t".repeat(43)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setRoleAnswerHandler(() => undefined);
});

describe("opening a report", () => {
  it("asks once, though StrictMode runs the effect twice, and says it is loading until the answer", async () => {
    const answer = held();
    const calls = fetchMock([on("GET", REPORT, answer.answer)]);
    show({ strict: true });
    expect(screen.getByRole("heading", { level: 2, name: "Report 0b1c1c4e" })).toBeInTheDocument();
    expect(screen.getByText("Loading the report…")).toHaveAttribute("aria-busy", "true");
    answer.release(json(detail()));
    expect(await loaded()).toBeInTheDocument();
    expect(screen.queryByText("Loading the report…")).toBeNull();
    expect(asked(calls)).toEqual([`GET ${REPORT}`]);
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${"t".repeat(43)}`);
  });

  it("shows the facts, both people with their histories, the reporter's words and the conversation, and no age", async () => {
    fetchMock([theReport()]);
    show();
    await loaded();
    expect(
      screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent),
    ).toEqual([
      "The report",
      "The two people",
      "The reporter's words",
      "The conversation as it was when reported",
      "Decision",
    ]);
    expect(termValue("Reason")).toBe("Harassment");
    expect(termValue("Made")).toBe("from a conversation");
    expect(termValue("Filed")).toBe(when(FILED));
    expect(termValue("State")).toBe("Waiting for a decision");
    expect(screen.queryByText(/Waited|Late/)).toBeNull();

    const reporter = screen.getByRole("link", { name: "Reported by account 1b0e0e3a" });
    expect(reporter).toHaveAttribute("href", `/accounts/${REPORTER}`);
    expect(reporter.closest("li")).toHaveTextContent(
      "Reported by account 1b0e0e3a · 3 reports filed, 1 upheld",
    );
    const reported = screen.getByRole("link", { name: "About account 6f1c1c4e" });
    expect(reported).toHaveAttribute("href", `/accounts/${REPORTED}`);
    expect(reported.closest("li")).toHaveTextContent(
      "About account 6f1c1c4e · 2 reports received, 1 sanction",
    );

    // The note keeps its line break, as text in a quotation.
    const note = screen.getByText(/He kept writing/);
    expect(note.tagName).toBe("BLOCKQUOTE");
    expect(note.textContent).toBe(NOTE);

    const copy = screen.getByRole("heading", {
      name: "The conversation as it was when reported",
    }).nextElementSibling as HTMLElement;
    expect(copy.tagName).toBe("OL");
    const lines = within(copy)
      .getAllByRole("listitem")
      .map((line) => line.textContent);
    expect(lines).toEqual([
      `Reporter · ${when(SAID(1))}Hi!`,
      `Reported person · ${when(SAID(2))}${MARKUP}`,
      `Reported person · ${when(SAID(3))}Show photo`,
      `Reporter · ${when(SAID(4))}Photo removed`,
    ]);
  });

  it("says the copy's sides in words and shows a body with markup as text, never as markup or a link", async () => {
    fetchMock([theReport()]);
    show();
    await loaded();
    const said = screen.getByText(MARKUP);
    expect(said.tagName).toBe("P");
    expect(said.children).toHaveLength(0);
    expect(screen.queryByRole("link", { name: "https://example.com" })).toBeNull();
    expect(screen.getAllByText("Reporter", { selector: "strong" })).toHaveLength(2);
    expect(screen.getAllByText("Reported person", { selector: "strong" })).toHaveLength(2);
  });

  it("has no conversation for a card's report, and says when the reporter wrote no note", async () => {
    fetchMock([theReport(detail({ source: "card", copy: null, note: null }))]);
    show();
    await loaded();
    expect(termValue("Made")).toBe("from a card");
    expect(screen.getByText("No note.")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "The conversation as it was when reported" }),
    ).toBeNull();
    expect(document.querySelector("blockquote")).toBeNull();
  });

  it("says a conversation that held no messages", async () => {
    fetchMock([theReport(detail({ copy: [] }))]);
    show();
    await loaded();
    expect(
      screen.getByRole("heading", { name: "The conversation as it was when reported" }),
    ).toBeInTheDocument();
    expect(screen.getByText("The conversation held no messages.")).toBeInTheDocument();
  });

  it.each([
    [404, "not_found"],
    [400, "validation_failed"],
  ])("says No such report on a %d and asks nothing more", async (code, error) => {
    const calls = fetchMock([on("GET", REPORT, () => failure(code, error))]);
    show();
    expect(await screen.findByText("No such report.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    expect(asked(calls)).toEqual([`GET ${REPORT}`]);
  });

  it("leaves a refusal to the shell: nothing of its own (#302)", async () => {
    const answers: boolean[] = [];
    setRoleAnswerHandler((allowed) => answers.push(allowed));
    const calls = fetchMock([on("GET", REPORT, () => failure(403, "admin_forbidden"))]);
    show();
    await waitFor(() => expect(answers).toEqual([false]));
    await waitFor(() => expect(screen.queryByText("Loading the report…")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("No such report.")).toBeNull();
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Report 0b1c1c4e" })).toBeInTheDocument();
    expect(asked(calls)).toEqual([`GET ${REPORT}`]);
  });

  it.each<[string, Answer]>([
    ["an error answer", () => failure(500, "internal_error")],
    ["an answer outside the contract", () => json({ ...detail(), copy: "none" })],
    ["no answer", unreachable],
  ])("says the report could not be loaded: %s", async (_, answer) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock([on("GET", REPORT, answer)]);
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("The report could not be loaded.");
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
  });

  it("links back to the reports", async () => {
    fetchMock([theReport()]);
    show();
    await loaded();
    fireEvent.click(screen.getByRole("link", { name: "Back to the reports" }));
    expect(await screen.findByText("the queue")).toBeInTheDocument();
  });

  it.each([
    [
      "acted on, naming a sanction",
      detail({ outcome: "acted", decidedAt: DECIDED, decidedBy: STAFF, sanctionId: sanctionId(7) }),
      `Acted on · ${when(DECIDED)} · Who: a1b2c3d4 · with sanction 5a1c1c4e`,
    ],
    [
      "acted on, its sanction erased since",
      detail({ outcome: "acted", decidedAt: DECIDED, decidedBy: STAFF }),
      `Acted on · ${when(DECIDED)} · Who: a1b2c3d4`,
    ],
    [
      "dismissed",
      detail({ outcome: "dismissed", decidedAt: DECIDED, decidedBy: STAFF }),
      `Dismissed · ${when(DECIDED)} · Who: a1b2c3d4`,
    ],
  ])("shows a decided report's outcome and no actions: %s", async (_, body, state) => {
    fetchMock([theReport(body)]);
    show({ role: "admin" });
    await loaded();
    expect(termValue("State")).toBe(state);
    expect(screen.queryByRole("group", { name: ACT })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.queryByText(/Reported for/)).toBeNull();
    expect(status()).toBeEmptyDOMElement();
  });

  it("links an acted-on decision's sanction to the reported person's page, where it is listed", async () => {
    fetchMock([
      theReport(
        detail({
          outcome: "acted",
          decidedAt: DECIDED,
          decidedBy: STAFF,
          sanctionId: sanctionId(7),
        }),
      ),
    ]);
    show();
    await loaded();
    fireEvent.click(screen.getByRole("link", { name: "with sanction 5a1c1c4e" }));
    expect(await screen.findByText(`the page of ${REPORTED}`)).toBeInTheDocument();
  });
});

describe("a photo of the conversation", () => {
  it("is asked for only when pressed, its full variant, and the picture takes the focus with its alt text", async () => {
    const calls = fetchMock([theReport(), on("GET", photoOf(3), full(3))]);
    show();
    await loaded();
    const button = screen.getByRole("button", { name: "Show photo" });
    // The button says which line it shows, by the line's first words.
    expect(button).toHaveAccessibleDescription(`Reported person · ${when(SAID(3))}`);
    expect(asked(calls)).toEqual([`GET ${REPORT}`]);
    fireEvent.click(button);
    const image = await screen.findByRole("img", {
      name: `Photo sent by the reported person. Sent: ${when(SAID(3))}`,
    });
    expect(image).toHaveAttribute("src", photoUrl(3));
    expect(image).toHaveClass("full");
    await waitFor(() => expect(image).toHaveFocus());
    expect(asked(calls)).toEqual([`GET ${REPORT}`, `GET ${photoOf(3)}`]);
    expect(screen.queryByRole("button", { name: "Show photo" })).toBeNull();
  });

  it("says the reporter's photo in its alt text", async () => {
    const copy = [
      { seq: 5, side: "reporter", kind: "photo", body: "Me", photo: true, createdAt: SAID(5) },
    ];
    fetchMock([theReport(detail({ copy })), on("GET", photoOf(5), full(5))]);
    show();
    await loaded();
    expect(screen.getByText("Me")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show photo" }));
    expect(
      await screen.findByRole("img", {
        name: `Photo sent by the reporter. Sent: ${when(SAID(5))}`,
      }),
    ).toHaveAttribute("src", photoUrl(5));
  });

  it("asks once for a photo pressed twice before its answer: one look, one photo.view row", async () => {
    const answer = held();
    const calls = fetchMock([theReport(), on("GET", photoOf(3), answer.answer)]);
    show();
    await loaded();
    const button = screen.getByRole("button", { name: "Show photo" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(asked(calls)).toEqual([`GET ${REPORT}`, `GET ${photoOf(3)}`]);
    answer.release(full(3)());
    expect(await screen.findByRole("img")).toHaveAttribute("src", photoUrl(3));
    expect(asked(calls)).toHaveLength(2);
  });

  it.each<[string, Answer]>([
    ["an error answer", () => failure(404, "not_found")],
    ["an answer outside the contract", () => json({ url: "not a url" })],
    ["no answer", unreachable],
  ])(
    "says a photo could not be shown, keeps the focus on its button, and shows it on the next press: %s",
    async (_, first) => {
      fetchMock([theReport(), on("GET", photoOf(3), first, full(3))]);
      show();
      await loaded();
      const button = screen.getByRole("button", { name: "Show photo" });
      button.focus();
      fireEvent.click(button);
      expect(await screen.findByRole("alert")).toHaveTextContent("The photo could not be shown.");
      expect(button).toHaveFocus();
      expect(screen.queryByRole("img")).toBeNull();
      fireEvent.click(button);
      expect(await screen.findByRole("img")).toHaveAttribute("src", photoUrl(3));
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("leaves a refused photo to the shell: no words of its own, the button stays (#302)", async () => {
    const calls = fetchMock([
      theReport(),
      on("GET", photoOf(3), () => failure(403, "admin_forbidden")),
    ]);
    show();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Show photo" }));
    await waitFor(() => expect(asked(calls)).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Show photo" })).not.toHaveAttribute("aria-busy"),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("acting on the reported person", () => {
  it.each<[ModeratorRole, string[]]>([
    ["moderator", ["Warn", "Hide from others (shadow ban)", "Suspend until a day"]],
    ["admin", ["Warn", "Hide from others (shadow ban)", "Suspend until a day", "Ban"]],
  ])("offers a %s these actions, beside the report's reason", async (role, buttons) => {
    fetchMock([theReport()]);
    show({ role });
    expect(
      within(await actions())
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(buttons);
    expect(screen.getByText("Reported for: Harassment")).toBeInTheDocument();
  });

  it("applies the sanction, then closes the report naming it, and says so where the focus goes, reading nothing again", async () => {
    const calls = fetchMock([
      theReport(),
      on("POST", SANCTIONS, () => json(sanction(1), 201)),
      on("POST", DECISION, () => json(decision("acted", sanctionId(1)))),
    ]);
    show({ strict: true });
    const { dialog, send } = await warn();
    expect(dialog).toHaveTextContent(
      "Applying one also closes this report as acted on; the reporter's export will say it was acted on, never which action.",
    );
    fireEvent.click(send);
    await waitFor(() =>
      expect(status()).toHaveTextContent("Applied: Warning. The report is closed as acted on."),
    );
    await waitFor(() => expect(status()).toHaveFocus());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(asked(calls)).toEqual([`GET ${REPORT}`, `POST ${SANCTIONS}`, `POST ${DECISION}`]);
    expect(await bodyOf(posted(calls, SANCTIONS)[0])).toEqual({
      kind: "warn",
      reason: "harassment",
      note: "Kept writing after a no",
    });
    expect(await bodyOf(posted(calls, DECISION)[0])).toEqual({
      outcome: "acted",
      sanctionId: sanctionId(1),
    });
    // In place, from the decision's answer: the state, and no actions any more.
    expect(termValue("State")).toBe(
      `Acted on · ${when(DECIDED)} · Who: a1b2c3d4 · with sanction 5a1c1c4e`,
    );
    expect(screen.queryByRole("group", { name: ACT })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("says a sanction stands when another member of staff decided the report meanwhile, with the person's page", async () => {
    const calls = fetchMock([
      theReport(),
      on("POST", SANCTIONS, () => json(sanction(1), 201)),
      on("POST", DECISION, () => failure(409, "report_decided")),
    ]);
    show();
    const { send } = await warn();
    fireEvent.click(send);
    await waitFor(() =>
      expect(status()).toHaveTextContent(
        "Applied: Warning, and it stands. Another member of staff decided this report meanwhile. The reported person's page, where it can be lifted",
      ),
    );
    await waitFor(() => expect(status()).toHaveFocus());
    expect(asked(calls)).toEqual([`GET ${REPORT}`, `POST ${SANCTIONS}`, `POST ${DECISION}`]);
    expect(screen.queryByRole("heading", { level: 4 })).toBeNull();
    fireEvent.click(
      within(status()).getByRole("link", {
        name: "The reported person's page, where it can be lifted",
      }),
    );
    expect(await screen.findByText(`the page of ${REPORTED}`)).toBeInTheDocument();
  });

  it("offers nothing that would close the report once another member of staff decided it", async () => {
    fetchMock([
      theReport(detail({ actable: [actable(2)] })),
      on("POST", SANCTIONS, () => json(sanction(1), 201)),
      on("POST", DECISION, () => failure(409, "report_decided")),
    ]);
    show();
    const { send } = await warn();
    fireEvent.click(send);
    await waitFor(() => expect(status()).toHaveTextContent("decided this report meanwhile"));
    expect(termValue("State")).toBe("Another member of staff decided this report meanwhile.");
    expect(screen.queryByRole("group", { name: ACT })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close with this" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("says it is closing the report while the decision is out, with nothing else to press meanwhile", async () => {
    const answer = held();
    const calls = fetchMock([
      theReport(),
      on("POST", SANCTIONS, () => json(sanction(1), 201)),
      on("POST", DECISION, answer.answer),
    ]);
    show();
    const { send } = await warn();
    fireEvent.click(send);
    await waitFor(() =>
      expect(status()).toHaveTextContent("Applied: Warning. Closing the report…"),
    );
    await waitFor(() => expect(status()).toHaveFocus());
    expect(screen.queryByRole("group", { name: ACT })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    answer.release(json(decision("acted", sanctionId(1))));
    await waitFor(() =>
      expect(status()).toHaveTextContent("Applied: Warning. The report is closed as acted on."),
    );
    expect(posted(calls, DECISION)).toHaveLength(1);
  });

  it.each<[string, Answer]>([
    ["cannot reach the API", unreachable],
    ["answers 500", () => failure(500, "internal_error")],
    ["refuses the sanction as not for this report", () => failure(409, "sanction_not_for_report")],
    ["answers not found", () => failure(404, "not_found")],
    ["leaves it to the shell", () => failure(403, "admin_forbidden")],
  ])(
    "lists a sanction that stands when closing the report with it %s, reading nothing again",
    async (_, answer) => {
      const calls = fetchMock([
        theReport(detail({ actable: [actable(2, { kind: "suspend", reason: "other" })] })),
        on("POST", SANCTIONS, () => json(sanction(1, { liftedAt: null }), 201)),
        on("POST", DECISION, answer),
      ]);
      show();
      const { send } = await warn();
      fireEvent.click(send);
      await waitFor(() =>
        expect(status()).toHaveTextContent(
          "Applied: Warning, and it stands. The report is not closed: close it with that sanction in the list above.",
        ),
      );
      await waitFor(() => expect(status()).toHaveFocus());
      expect(within(status()).queryByRole("link")).toBeNull();
      const list = screen.getByRole("heading", {
        level: 4,
        name: "Close as acted on with a sanction applied since the report",
      }).nextElementSibling as HTMLElement;
      expect(
        within(list)
          .getAllByRole("listitem")
          .map((item) => item.querySelector("p")?.textContent),
      ).toEqual([
        `Warning · Harassment · ${when(APPLIED)}`,
        `Suspension · Other · ${when(APPLIED)}`,
      ]);
      // The actions stay: the report still waits.
      expect(await actions()).toBeInTheDocument();
      expect(asked(calls).filter((call) => call.startsWith("GET"))).toEqual([`GET ${REPORT}`]);
    },
  );

  it("closes the report in one more step with the sanction that stands", async () => {
    const calls = fetchMock([
      theReport(),
      on("POST", SANCTIONS, () => json(sanction(1), 201)),
      on("POST", DECISION, unreachable, () => json(decision("acted", sanctionId(1)))),
    ]);
    show();
    const { send } = await warn();
    fireEvent.click(send);
    const close = await screen.findByRole("button", { name: "Close with this" });
    const dialog = press(close);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close report" }));
    await waitFor(() => expect(status()).toHaveTextContent("Report closed as acted on."));
    const decisions = posted(calls, DECISION);
    expect(decisions).toHaveLength(2);
    expect(await bodyOf(decisions[1])).toEqual({ outcome: "acted", sanctionId: sanctionId(1) });
  });

  it("keeps a refused sanction in its step, and closes nothing", async () => {
    const calls = fetchMock([
      theReport(),
      on("POST", SANCTIONS, () => failure(409, "staff_target")),
    ]);
    show();
    const { dialog, send } = await warn();
    fireEvent.click(send);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "This person is staff: the role is taken away first.",
    );
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(asked(calls)).toEqual([`GET ${REPORT}`, `POST ${SANCTIONS}`]);
    expect(status()).toBeEmptyDOMElement();
  });

  it("clears the last outcome's words when the next step opens", async () => {
    fetchMock([
      theReport(),
      on("POST", SANCTIONS, () => json(sanction(1), 201)),
      on("POST", DECISION, unreachable),
    ]);
    show();
    const { send } = await warn();
    fireEvent.click(send);
    await waitFor(() => expect(status()).toHaveTextContent(/and it stands/));
    press(within(await actions()).getByRole("button", { name: "Warn" }));
    expect(status()).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Close with this" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(status()).toBeEmptyDOMElement();
  });
});

describe("closing the report with a sanction applied since", () => {
  const LISTED = [
    actable(3, { liftedAt: DECIDED }),
    actable(4, { kind: "suspend", reason: "other" }),
  ];

  it("lists each with its kind, reason, time and whether lifted, and its button says which", async () => {
    fetchMock([theReport(detail({ actable: LISTED }))]);
    show();
    await loaded();
    const buttons = screen.getAllByRole("button", { name: "Close with this" });
    expect(buttons.map((button) => button.textContent)).toHaveLength(2);
    expect(buttons[0]).toHaveAccessibleDescription(
      `Warning · Harassment · ${when(APPLIED)} · lifted`,
    );
    expect(buttons[1]).toHaveAccessibleDescription(`Suspension · Other · ${when(APPLIED)}`);
  });

  it("says the effect, names the sanction chosen, and updates the page in place", async () => {
    const calls = fetchMock([
      theReport(detail({ actable: LISTED })),
      on("POST", DECISION, () => json(decision("acted", sanctionId(4)))),
    ]);
    show();
    await loaded();
    const dialog = press(
      screen.getAllByRole("button", { name: "Close with this" })[1] as HTMLElement,
    );
    expect(
      within(dialog).getByRole("heading", { name: "Close the report as acted on" }),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      `The report closes as acted on, naming this sanction: Suspension, applied ${when(APPLIED)}. Nothing more happens to the reported person; the reporter's export will say it was acted on, never which action.`,
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Close report" }));
    await waitFor(() => expect(status()).toHaveTextContent("Report closed as acted on."));
    await waitFor(() => expect(status()).toHaveFocus());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await bodyOf(posted(calls, DECISION)[0])).toEqual({
      outcome: "acted",
      sanctionId: sanctionId(4),
    });
    expect(termValue("State")).toBe(
      `Acted on · ${when(DECIDED)} · Who: a1b2c3d4 · with sanction 5a1c1c4e`,
    );
    expect(screen.queryByRole("button", { name: "Close with this" })).toBeNull();
    expect(asked(calls)).toEqual([`GET ${REPORT}`, `POST ${DECISION}`]);
  });

  it.each<[string, Answer, string]>([
    [
      "a sanction not for this report",
      () => failure(409, "sanction_not_for_report"),
      "That sanction does not answer this report.",
    ],
    ["no such report", () => failure(404, "not_found"), "No such report."],
    ["another failure", () => failure(500, "internal_error"), "The decision could not be saved."],
    ["no answer", unreachable, "The decision could not be saved."],
  ])("says a refusal in words, the step kept open: %s", async (_, answer, words) => {
    fetchMock([theReport(detail({ actable: LISTED })), on("POST", DECISION, answer)]);
    show();
    await loaded();
    const dialog = press(
      screen.getAllByRole("button", { name: "Close with this" })[0] as HTMLElement,
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Close report" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(words);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(status()).toBeEmptyDOMElement();
    expect(termValue("State")).toBe("Waiting for a decision");
  });

  it("closes the step when another member of staff decided the report meanwhile, and offers nothing more", async () => {
    fetchMock([
      theReport(detail({ actable: LISTED })),
      on("POST", DECISION, () => failure(409, "report_decided")),
    ]);
    show();
    await loaded();
    const dialog = press(
      screen.getAllByRole("button", { name: "Close with this" })[0] as HTMLElement,
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Close report" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(status()).toHaveTextContent("Another member of staff decided this report meanwhile.");
    await waitFor(() => expect(status()).toHaveFocus());
    expect(termValue("State")).toBe("Another member of staff decided this report meanwhile.");
    expect(screen.queryByRole("button", { name: "Close with this" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("leaves a refused decision to the shell: the step closes, the focus goes back (#302)", async () => {
    fetchMock([
      theReport(detail({ actable: LISTED })),
      on("POST", DECISION, () => failure(403, "admin_forbidden")),
    ]);
    show();
    await loaded();
    const button = screen.getAllByRole("button", { name: "Close with this" })[0] as HTMLElement;
    const dialog = press(button);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close report" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(status()).toBeEmptyDOMElement();
    expect(button).toHaveFocus();
  });
});

describe("dismissing the report", () => {
  it.each(["Cancel", "Escape"])(
    "says the effect, and %s sends nothing and gives the focus back",
    async (how) => {
      const calls = fetchMock([theReport()]);
      show();
      await loaded();
      const button = screen.getByRole("button", { name: "Dismiss" });
      expect(button).toHaveClass("apart");
      const dialog = press(button);
      expect(
        within(dialog).getByRole("heading", { name: "Dismiss the report" }),
      ).toBeInTheDocument();
      expect(dialog).toHaveTextContent(
        "The report closes with no action on the reported person. The block between the two stays. The reporter's export will say it was dismissed.",
      );
      if (how === "Cancel") fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      else fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(button).toHaveFocus();
      expect(asked(calls)).toEqual([`GET ${REPORT}`]);
    },
  );

  it("dismisses on confirm, updating the page in place with no second read, and the decision area goes", async () => {
    const calls = fetchMock([theReport(), on("POST", DECISION, () => json(decision("dismissed")))]);
    show({ strict: true });
    await loaded();
    const dialog = press(screen.getByRole("button", { name: "Dismiss" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss report" }));
    await waitFor(() => expect(status()).toHaveTextContent("Report dismissed."));
    await waitFor(() => expect(status()).toHaveFocus());
    expect(await bodyOf(posted(calls, DECISION)[0])).toEqual({ outcome: "dismissed" });
    expect(asked(calls)).toEqual([`GET ${REPORT}`, `POST ${DECISION}`]);
    expect(termValue("State")).toBe(`Dismissed · ${when(DECIDED)} · Who: a1b2c3d4`);
    expect(screen.queryByRole("group", { name: ACT })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.queryByText(/Reported for/)).toBeNull();
  });

  it("sends a dismissal pressed twice before its answer once", async () => {
    const answer = held();
    const calls = fetchMock([theReport(), on("POST", DECISION, answer.answer)]);
    show();
    await loaded();
    const dialog = press(screen.getByRole("button", { name: "Dismiss" }));
    const send = within(dialog).getByRole("button", { name: "Dismiss report" });
    fireEvent.click(send);
    fireEvent.click(send);
    expect(send).toHaveAttribute("aria-busy", "true");
    expect(send).toBeEnabled();
    answer.release(json(decision("dismissed")));
    await waitFor(() => expect(status()).toHaveTextContent("Report dismissed."));
    expect(posted(calls, DECISION)).toHaveLength(1);
  });
});
