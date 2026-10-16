import { formatDateTime } from "@kuutti/i18n";
import { I18nProvider } from "@kuutti/i18n/react";
import { type ModeratorRole, Sanction, type SanctionEntry } from "@kuutti/schema";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setTokenSource } from "../../lib/api.ts";
import { StaffRole } from "../../lib/role.ts";
import { AccountPage } from "./AccountPage.tsx";

// The sanctions on a person's page (#308) as staff use them: the actions per
// role, each confirm step with its words, its fields and the exact request,
// the refusals in words, the history with who did what, the lift and the
// second look. The page is rendered whole at its path, inside the role the
// shell gives (StaffRole), and the API is a fake fetch keyed on method and
// path, each answer in turn.

const ID = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const STAFF = "a1b2c3d4-9a8e-4a0b-9c3a-0c8d1e2f3a99";
const OTHER = "c3d4e5f6-9a8e-4a0b-9c3a-0c8d1e2f3a98";
const GONE = "e5f6a7b8-9a8e-4a0b-9c3a-0c8d1e2f3a97";
const sanctionId = (n: number) =>
  `5a1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a${n.toString(16).padStart(2, "0")}`;

const APPLIED = "2026-10-10T09:00:00.000Z";
const UNTIL = "2026-10-31T22:00:00.000Z";
const LIFTED = "2026-10-12T16:20:00.000Z";
const LOOKED = "2026-10-15T12:00:00.000Z";
const when = (at: string) => formatDateTime("en", new Date(at));

/** A person with nothing else on the page: the sanctions are what is looked at. */
const page = {
  id: ID,
  state: "registered",
  stateChangedAt: null,
  registeredAt: "2026-09-01T08:00:00.000Z",
  deletedAt: null,
  standing: "ok",
  standingChangedAt: null,
  suspensionEndsAt: null,
  age: null,
  gender: null,
  pond: null,
  profile: null,
  photos: [],
  feedback: [],
  audit: [],
};

/** A row of the list: an open suspension a moderator applied, unless told otherwise. */
const entry = (n: number, extra: Partial<SanctionEntry> = {}): SanctionEntry => ({
  id: sanctionId(n),
  accountId: ID,
  kind: "suspend",
  reason: "harassment",
  note: "Wrote something unkind in two chats",
  endsAt: UNTIL,
  createdBy: STAFF,
  createdAt: APPLIED,
  liftedAt: null,
  liftedBy: null,
  reviewNote: null,
  reviewedBy: null,
  reviewedAt: null,
  createdByRole: "moderator",
  liftedByRole: null,
  reviewedByRole: null,
  ...extra,
});
/** What a sanction route answers: the sanction, without the roles the list adds. */
const answerOf = (item: SanctionEntry): Sanction => Sanction.parse(item);

/** An open suspension and an open ban, the rows the lift and the second look start from. */
const OPEN = entry(1);
const OPEN_BAN = entry(6, {
  kind: "ban",
  reason: "under_age",
  note: "Said they are fifteen",
  endsAt: null,
  createdBy: OTHER,
  createdByRole: "admin",
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
/** An answer that waits until the test lets it go, whenever the request comes. */
function held() {
  let release: (res: Response) => void = () => undefined;
  const answer = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { answer: () => answer, release: (res: Response) => release(res) };
}

const PAGE = `/admin/accounts/${ID}`;
const LIST = `/admin/accounts/${ID}/sanctions`;
const BANS = `/admin/accounts/${ID}/bans`;
const thePage = (...answers: Answer[]) =>
  on("GET", PAGE, ...(answers.length > 0 ? answers : [() => json(page)]));
/** The list's answers in turn: the first read, then each read again. */
const listOf = (...lists: SanctionEntry[][]) =>
  on("GET", LIST, ...lists.map((items) => () => json({ items })));
const asked = (calls: Request[]) => calls.map((c) => `${c.method} ${path(c)}`);
const bodyOf = async (req: Request | undefined) => {
  const text = await req?.clone().text();
  return text ? JSON.parse(text) : null;
};
const liftRoute = (item: SanctionEntry) =>
  `/admin/${item.kind === "ban" ? "bans" : "sanctions"}/${item.id}/lift`;
const reviewRoute = (item: SanctionEntry) =>
  `/admin/${item.kind === "ban" ? "bans" : "sanctions"}/${item.id}/review`;

function show(role: ModeratorRole | null = "moderator") {
  render(
    <I18nProvider i18n={i18n}>
      <StaffRole.Provider value={role}>
        <MemoryRouter initialEntries={[`/accounts/${ID}`]}>
          <Routes>
            <Route path="/accounts/:id" element={<AccountPage />} />
          </Routes>
        </MemoryRouter>
      </StaffRole.Provider>
    </I18nProvider>,
  );
}

const ACTIONS = "Actions on this person";
const NOTE = "Note: what happened, in a few words";
const ENDS = "Suspended until the start of this day";
const TEXT = "Spam links in every chat";
const REASONS = [
  "Choose a reason",
  "Harassment",
  "Misrepresentation",
  "Under 18",
  "Commercial use",
  "Scraping",
  "Other",
];
const MODERATOR_ACTIONS = ["Warn", "Hide from others (shadow ban)", "Suspend until a day"];

const actions = () => screen.findByRole("group", { name: ACTIONS });
const buttonsIn = (scope: HTMLElement) =>
  within(scope)
    .queryAllByRole("button")
    .map((button) => button.textContent);
/** A row of the history, found by its note; waits for the list. */
const rowOf = async (note: string) =>
  (await screen.findByText(note, { selector: "li > p" })).closest("li") as HTMLElement;
/** A row's lines: kind and reason, the note, who applied, lifted, looked at again. */
const lines = (row: HTMLElement) => [...row.querySelectorAll("p")].map((p) => p.textContent);

/** Presses a button as a keyboard does, so it has the focus a dialog gives back. */
function press(name: string, scope: HTMLElement) {
  const button = within(scope).getByRole("button", { name });
  button.focus();
  fireEvent.click(button);
  return { button, dialog: screen.getByRole("dialog") };
}

/** Fills an action's step: a reason, the note with spaces around it, a day for a suspension. */
function fill(dialog: HTMLElement, { endsOn }: { endsOn?: string } = {}) {
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Reason" }), {
    target: { value: "harassment" },
  });
  fireEvent.change(within(dialog).getByRole("textbox", { name: NOTE }), {
    target: { value: `  ${TEXT}  ` },
  });
  if (endsOn) fireEvent.change(within(dialog).getByLabelText(ENDS), { target: { value: endsOn } });
}

type Step = "warn" | "suspend" | "ban" | "lift" | "review";
const STEP_ROUTE: Record<Step, (item: SanctionEntry) => string> = {
  warn: () => LIST,
  suspend: () => LIST,
  ban: () => BANS,
  lift: liftRoute,
  review: reviewRoute,
};
const ACTION_NAME = { warn: "Warn", suspend: "Suspend until a day", ban: "Ban" } as const;

/** Opens a step and fills it in, ready to send: its opener, the dialog, and the button that sends. */
async function ready(step: Step, item: SanctionEntry = OPEN) {
  if (step === "lift") {
    const { button, dialog } = press("Lift", await rowOf(item.note));
    return { button, dialog, send: within(dialog).getByRole("button", { name: "Lift" }) };
  }
  if (step === "review") {
    const { button, dialog } = press("Look at it again", await rowOf(item.note));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Your note" }), {
      target: { value: `  ${TEXT}  ` },
    });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Keep it" }));
    return { button, dialog, send: within(dialog).getByRole("button", { name: "Apply" }) };
  }
  const page = await actions();
  // The suspension's day field takes its bounds from today: pinned, so 2026-11-01 is always in them.
  if (step === "suspend") {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 16, 12));
  }
  const { button, dialog } = press(ACTION_NAME[step], page);
  fill(dialog, step === "suspend" ? { endsOn: "2026-11-01" } : {});
  return { button, dialog, send: within(dialog).getByRole("button", { name: "Apply" }) };
}

beforeEach(() => setTokenSource(() => "t".repeat(43)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the actions on a person", () => {
  it.each<[string, ModeratorRole | null]>([
    ["a moderator", "moderator"],
    ["a page outside the shell, with no role", null],
  ])("are warn, hide and suspend for %s, with no ban", async (_who, role) => {
    fetchMock([thePage(), listOf([])]);
    show(role);
    expect(buttonsIn(await actions())).toEqual(MODERATOR_ACTIONS);
    expect(screen.queryByRole("button", { name: "Ban" })).toBeNull();
  });

  it("are the same and the ban last for an admin", async () => {
    fetchMock([thePage(), listOf([])]);
    show("admin");
    expect(buttonsIn(await actions())).toEqual([...MODERATOR_ACTIONS, "Ban"]);
  });

  it.each([
    {
      kind: "warn",
      role: "moderator",
      button: "Warn",
      title: "Warn this person",
      effect: "Writes a warning on the person's file. Nothing else changes for them.",
      reason: "harassment",
      route: LIST,
      body: { kind: "warn", reason: "harassment", note: TEXT },
      done: "Applied: Warning.",
      words: `Warning · Harassment · ${when(APPLIED)}`,
    },
    {
      kind: "shadow_ban",
      role: "moderator",
      button: "Hide from others (shadow ban)",
      title: "Hide this person from others",
      effect:
        "Hides the person from everyone else at once, without telling them: they see no change.",
      reason: "scraping",
      route: LIST,
      body: { kind: "shadow_ban", reason: "scraping", note: TEXT },
      done: "Applied: Shadow ban.",
      words: `Shadow ban · Scraping · ${when(APPLIED)}`,
    },
    {
      kind: "suspend",
      role: "moderator",
      button: "Suspend until a day",
      title: "Suspend this person",
      effect:
        "Ends every session now and refuses the bank login until the start of the chosen day in Finland, when the night lifts it.",
      reason: "misrepresentation",
      route: LIST,
      body: { kind: "suspend", reason: "misrepresentation", note: TEXT, endsOn: "2026-11-01" },
      done: "Applied: Suspension.",
      words: `Suspension · Misrepresentation · ${when(APPLIED)} · until: ${when(UNTIL)}`,
    },
    {
      kind: "ban",
      role: "admin",
      button: "Ban",
      title: "Ban this person",
      effect:
        "Ends every session now and refuses the next bank login and any new account, until an admin lifts it.",
      reason: "under_age",
      route: BANS,
      body: { reason: "under_age", note: TEXT },
      done: "Applied: Ban.",
      words: `Ban · Under 18 · ${when(APPLIED)}`,
    },
  ] as const)(
    "$button ($role): says the effect, asks a reason, a note and what else it needs, sends it, then shows the new row",
    async (a) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 9, 16, 12));
      const added = entry(9, {
        kind: a.kind,
        reason: a.reason,
        note: TEXT,
        endsAt: a.kind === "suspend" ? UNTIL : null,
        createdByRole: a.role,
      });
      const calls = fetchMock([
        thePage(),
        listOf([], [added]),
        on("POST", a.route, () => json(answerOf(added), 201)),
      ]);
      show(a.role);
      const { button, dialog } = press(a.button, await actions());
      expect(screen.getByRole("dialog", { name: a.title })).toBe(dialog);
      expect(within(dialog).getByText(a.effect)).toBeInTheDocument();

      // The reason is chosen on purpose: nothing preset, the prompt itself not a choice.
      const reason = within(dialog).getByRole("combobox", { name: "Reason" });
      expect(reason).toHaveFocus();
      expect(reason).toHaveValue("");
      expect(
        within(reason)
          .getAllByRole("option")
          .map((option) => option.textContent),
      ).toEqual(REASONS);
      expect(within(reason).getByRole("option", { name: "Choose a reason" })).toBeDisabled();
      const note = within(dialog).getByRole("textbox", { name: NOTE });
      expect(note).toHaveAccessibleDescription("Characters: 0/500");
      expect(note).toHaveAttribute("maxlength", "500");
      const apply = within(dialog).getByRole("button", { name: "Apply" });
      expect(apply).toBeDisabled();

      fireEvent.change(reason, { target: { value: a.reason } });
      expect(apply).toBeDisabled();
      fireEvent.change(note, { target: { value: "   " } });
      expect(note).toHaveAccessibleDescription("Characters: 3/500");
      expect(apply).toBeDisabled();
      fireEvent.change(note, { target: { value: `  ${TEXT}  ` } });
      expect(note).toHaveAccessibleDescription(`Characters: ${TEXT.length + 4}/500`);
      if (a.kind === "suspend") {
        // A suspension waits for its day too.
        expect(apply).toBeDisabled();
        const day = within(dialog).getByLabelText(ENDS);
        expect(day).toHaveAttribute("type", "date");
        fireEvent.change(day, { target: { value: "2026-11-01" } });
      } else {
        expect(within(dialog).queryByLabelText(ENDS)).toBeNull();
      }
      expect(apply).toBeEnabled();

      fireEvent.click(apply);
      const status = screen.getByRole("status");
      await waitFor(() => expect(status).toHaveTextContent(a.done));
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(status).toHaveFocus());
      expect(button).not.toHaveFocus();
      expect(lines(await rowOf(TEXT))[0]).toBe(a.words);
      expect(asked(calls)).toEqual([
        `GET ${PAGE}`,
        `GET ${LIST}`,
        `POST ${a.route}`,
        `GET ${PAGE}`,
        `GET ${LIST}`,
      ]);
      expect(await bodyOf(calls[2])).toEqual(a.body);
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it.each([
    ["noon on 16 October 2026", new Date(2026, 9, 16, 12), "2026-10-17", "2027-10-17"],
    [
      "half past midnight on 17 October 2026",
      new Date(2026, 9, 17, 0, 30),
      "2026-10-18",
      "2027-10-18",
    ],
    ["the last day of 2026", new Date(2026, 11, 31, 12), "2027-01-01", "2028-01-01"],
    ["28 February of a leap year", new Date(2028, 1, 28, 12), "2028-02-29", "2029-02-28"],
  ])(
    "offers a suspension's day from tomorrow to 366 days ahead in the browser's calendar, at %s",
    async (_at, now, min, max) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      fetchMock([thePage(), listOf([])]);
      show();
      const { dialog } = press("Suspend until a day", await actions());
      const day = within(dialog).getByLabelText(ENDS);
      expect(day).toHaveAttribute("min", min);
      expect(day).toHaveAttribute("max", max);
      expect(day).toBeRequired();
      expect(day).toHaveValue("");
    },
  );

  it("reads the page again in place after a change: no loading step, the status line keeps the focus, then the new row", async () => {
    const again = held();
    const added = entry(9, { kind: "warn", note: TEXT, endsAt: null });
    const calls = fetchMock([
      thePage(() => json(page), again.answer),
      listOf([], [added]),
      on("POST", LIST, () => json(answerOf(added), 201)),
    ]);
    show();
    const { send } = await ready("warn");
    fireEvent.click(send);
    const status = screen.getByRole("status");
    await waitFor(() => expect(status).toHaveTextContent("Applied: Warning."));
    await waitFor(() => expect(asked(calls)).toHaveLength(4));
    expect(asked(calls)[3]).toBe(`GET ${PAGE}`);
    // While the page is read again, it stays as it was, with no loading words.
    expect(status).toHaveFocus();
    expect(screen.queryByText("Loading the page…")).toBeNull();
    expect(screen.getByRole("heading", { level: 3, name: "Sanctions" })).toBeInTheDocument();
    expect(screen.queryByText(TEXT)).toBeNull();
    again.release(json(page));
    expect(await rowOf(TEXT)).toBeInTheDocument();
    expect(status).toHaveFocus();
    expect(status).toHaveTextContent("Applied: Warning.");
    // The next step clears the line.
    press("Warn", await actions());
    expect(status).toBeEmptyDOMElement();
  });

  it.each<[string, Answer]>([
    [
      "cannot reach the API",
      () => {
        throw new TypeError("Failed to fetch");
      },
    ],
    ["gets an answer outside the contract", () => json({ ...page, state: "frozen" })],
  ])(
    "still says what was done, and keeps the focus on the page, when reading it again %s",
    async (_how, again) => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const added = entry(9, { kind: "warn", note: TEXT, endsAt: null });
      const calls = fetchMock([
        thePage(() => json(page), again),
        listOf([], [added]),
        on("POST", LIST, () => json(answerOf(added), 201)),
      ]);
      show();
      const { send } = await ready("warn");
      fireEvent.click(send);
      await waitFor(() => expect(asked(calls)).toHaveLength(4));
      // The read again has failed and its outcome is on the page.
      await waitFor(() =>
        expect(logged).toHaveBeenCalledWith("account page load failed", expect.anything()),
      );
      await act(async () => undefined);
      // The sanction was applied: the moderator is not left to wonder, and to apply it twice.
      expect(screen.getByRole("status")).toHaveTextContent("Applied: Warning.");
      expect(document.activeElement).not.toBe(document.body);
    },
  );

  it("keeps the page as it was when reading it again is refused: that is the shell's to say", async () => {
    const added = entry(9, { kind: "warn", note: TEXT, endsAt: null });
    const calls = fetchMock([
      thePage(
        () => json(page),
        () => failure(403, "admin_forbidden"),
      ),
      listOf([], [added]),
      on("POST", LIST, () => json(answerOf(added), 201)),
    ]);
    show();
    const { send } = await ready("warn");
    fireEvent.click(send);
    await waitFor(() => expect(asked(calls)).toHaveLength(4));
    const status = screen.getByRole("status");
    await waitFor(() => expect(status).toHaveTextContent("Applied: Warning."));
    expect(status).toHaveFocus();
    // Photos, sanctions, feedback and the audit as they were: each empty.
    expect(screen.getAllByText("None.")).toHaveLength(4);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(buttonsIn(await actions())).toEqual(MODERATOR_ACTIONS);
    expect(asked(calls)).toEqual([`GET ${PAGE}`, `GET ${LIST}`, `POST ${LIST}`, `GET ${PAGE}`]);
  });

  it.each(["Cancel", "Escape"])(
    "%s closes the step with nothing sent and nothing kept, the focus back on the action",
    async (how) => {
      const calls = fetchMock([thePage(), listOf([])]);
      show();
      const { button, dialog } = await ready("warn");
      if (how === "Cancel") fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      else
        fireEvent.keyDown(within(dialog).getByRole("textbox", { name: NOTE }), { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(button).toHaveFocus();
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
      // Opened again, the step starts empty.
      const again = press("Warn", await actions()).dialog;
      expect(within(again).getByRole("combobox", { name: "Reason" })).toHaveValue("");
      expect(within(again).getByRole("textbox", { name: NOTE })).toHaveValue("");
      expect(within(again).getByRole("button", { name: "Apply" })).toBeDisabled();
      expect(asked(calls)).toEqual([`GET ${PAGE}`, `GET ${LIST}`]);
    },
  );

  it.each<Step>(["lift", "review"])(
    "Cancel closes the %s step with nothing sent, the focus back on the row's button",
    async (step) => {
      const calls = fetchMock([thePage(), listOf([OPEN])]);
      show();
      const { button, dialog } = await ready(step);
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(button).toHaveFocus();
      expect(asked(calls)).toEqual([`GET ${PAGE}`, `GET ${LIST}`]);
    },
  );

  it.each<[Step, number, string, string, SanctionEntry]>([
    ["warn", 409, "staff_target", "This person is staff: the role is taken away first.", OPEN],
    ["ban", 409, "staff_target", "This person is staff: the role is taken away first.", OPEN],
    ["warn", 409, "account_deleted", "The account is erased: only a ban binds it.", OPEN],
    [
      "suspend",
      400,
      "ends_on_invalid",
      "The end day is after today and at most 366 days ahead.",
      OPEN,
    ],
    ["warn", 404, "not_found", "It is not there any more.", OPEN],
    ["lift", 409, "own_account", "This is about your own account: somebody else decides.", OPEN],
    ["lift", 409, "sanction_lifted", "It is lifted already.", OPEN],
    ["lift", 404, "not_found", "It is not there any more.", OPEN_BAN],
    ["review", 409, "own_sanction", "You applied this one: somebody else looks at it again.", OPEN],
    ["review", 409, "sanction_reviewed", "Somebody looked at it again already.", OPEN_BAN],
    ["review", 409, "sanction_lifted", "It is lifted already.", OPEN],
    ["review", 409, "own_account", "This is about your own account: somebody else decides.", OPEN],
  ])(
    "%s refused with a %i %s: said in words inside the step, which stays open to try again",
    async (step, status, code, words, item) => {
      const route = STEP_ROUTE[step](item);
      const calls = fetchMock([
        thePage(),
        listOf([OPEN, OPEN_BAN]),
        on("POST", route, () => failure(status, code)),
      ]);
      show("admin");
      const { dialog, send } = await ready(step, item);
      fireEvent.click(send);
      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toBe(words);
      expect(screen.getByRole("dialog")).toBe(dialog);
      await waitFor(() => expect(send).toBeEnabled());
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
      expect(asked(calls)).toEqual([`GET ${PAGE}`, `GET ${LIST}`, `POST ${route}`]);
    },
  );

  it.each<[string, Answer]>([
    ["a 500", () => failure(500, "internal_error")],
    [
      "no answer at all",
      () => {
        throw new TypeError("Failed to fetch");
      },
    ],
    ["a success outside the contract", () => json({ id: "not a sanction" }, 201)],
    ["a refusal with no words of its own", () => failure(400, "validation_failed")],
    [
      "a gateway's page instead of the API's envelope",
      () => new Response("Bad gateway", { status: 502 }),
    ],
  ])("says it could not be done on %s, the step kept open", async (_what, answer) => {
    const calls = fetchMock([thePage(), listOf([]), on("POST", LIST, answer)]);
    show();
    const { dialog, send } = await ready("warn");
    fireEvent.click(send);
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "It could not be done. Try again.",
    );
    expect(screen.getByRole("dialog")).toBe(dialog);
    await waitFor(() => expect(send).toBeEnabled());
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(asked(calls)).toEqual([`GET ${PAGE}`, `GET ${LIST}`, `POST ${LIST}`]);
  });

  it("says a lift that cannot reach the API could not be done, the step kept open", async () => {
    fetchMock([
      thePage(),
      listOf([OPEN]),
      on("POST", liftRoute(OPEN), () => {
        throw new TypeError("Failed to fetch");
      }),
    ]);
    show();
    const { dialog } = await ready("lift");
    fireEvent.click(within(dialog).getByRole("button", { name: "Lift" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "It could not be done. Try again.",
    );
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("takes a refusal's words away when the step is sent again", async () => {
    const second = held();
    const added = entry(9, { kind: "warn", note: TEXT, endsAt: null });
    const calls = fetchMock([
      thePage(),
      listOf([], [added]),
      on("POST", LIST, () => failure(409, "staff_target"), second.answer),
    ]);
    show();
    const { dialog, send } = await ready("warn");
    fireEvent.click(send);
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(send).toHaveAttribute("aria-busy", "true");
    second.release(json(answerOf(added), 201));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Applied: Warning."));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(asked(calls).filter((call) => call.startsWith("POST"))).toHaveLength(2);
  });

  it.each<[Step, SanctionEntry]>([
    ["warn", OPEN],
    ["ban", OPEN],
    ["lift", OPEN_BAN],
    ["review", OPEN],
  ])(
    "leaves a refused %s to the shell: the step closes with no words of its own (#302)",
    async (step, item) => {
      const route = STEP_ROUTE[step](item);
      const calls = fetchMock([
        thePage(),
        listOf([OPEN, OPEN_BAN]),
        on("POST", route, () => failure(403, "admin_forbidden")),
      ]);
      show("admin");
      const { button, send } = await ready(step, item);
      fireEvent.click(send);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
      expect(button).toHaveFocus();
      expect(asked(calls)).toEqual([`GET ${PAGE}`, `GET ${LIST}`, `POST ${route}`]);
    },
  );

  it.each<[Step, string]>([
    ["warn", "Applied: Warning."],
    ["lift", "Lifted: Suspension."],
    ["review", "Looked at again: Suspension."],
  ])("sends a %s pressed twice before its answer once", async (step, done) => {
    const answer = held();
    const route = STEP_ROUTE[step](OPEN);
    const calls = fetchMock([thePage(), listOf([OPEN]), on("POST", route, answer.answer)]);
    show();
    const { dialog, send } = await ready(step);
    send.focus();
    fireEvent.click(send);
    fireEvent.click(send);
    // Busy but enabled, so the focus stays in the dialog: a second press is a no-op.
    expect(send).toHaveAttribute("aria-busy", "true");
    expect(send).toBeEnabled();
    expect(send).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
    fireEvent.click(send);
    await waitFor(() => expect(asked(calls)).toHaveLength(3));
    answer.release(json(answerOf(OPEN), step === "warn" ? 201 : 200));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(done));
    await waitFor(() => expect(asked(calls)).toHaveLength(5));
    expect(asked(calls)).toEqual([
      `GET ${PAGE}`,
      `GET ${LIST}`,
      `POST ${route}`,
      `GET ${PAGE}`,
      `GET ${LIST}`,
    ]);
  });
});

describe("the sanctions' history", () => {
  const SUSPENDED = OPEN;
  const LOOKED_AT = entry(2, {
    kind: "warn",
    reason: "other",
    note: "Asked for a phone number in the first message",
    endsAt: null,
    liftedAt: LIFTED,
    liftedBy: OTHER,
    liftedByRole: "admin",
    reviewNote: "Not what the rule means",
    reviewedBy: GONE,
    reviewedByRole: null,
    reviewedAt: LOOKED,
  });
  const BY_KUUTTI = entry(3, {
    kind: "shadow_ban",
    reason: "scraping",
    note: "Opened two hundred cards a minute",
    endsAt: null,
    createdBy: null,
    createdByRole: null,
  });
  const ENDED = entry(4, {
    reason: "misrepresentation",
    note: "Photos of somebody else",
    liftedAt: UNTIL,
  });
  const KEPT = entry(5, {
    kind: "warn",
    reason: "commercial_use",
    note: "Sold sauna visits",
    endsAt: null,
    reviewNote: "Fair",
    reviewedBy: OTHER,
    reviewedByRole: "moderator",
    reviewedAt: LOOKED,
  });
  const HISTORY = [SUSPENDED, LOOKED_AT, BY_KUUTTI, ENDED, KEPT, OPEN_BAN];

  it("shows each sanction's kind and reason in words, its dates, its note, and who did what by the start of their id and their role now", async () => {
    fetchMock([thePage(), listOf(HISTORY)]);
    show();
    const first = await rowOf(SUSPENDED.note);
    const list = first.closest("ul") as HTMLElement;
    // Newest first, as the API lists them.
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((row) => lines(row)[1]),
    ).toEqual(HISTORY.map((item) => item.note));
    expect(lines(first)).toEqual([
      `Suspension · Harassment · ${when(APPLIED)} · until: ${when(UNTIL)}`,
      SUSPENDED.note,
      "Applied by: a1b2c3d4, moderator",
    ]);
    expect(lines(await rowOf(LOOKED_AT.note))).toEqual([
      `Warning · Other · ${when(APPLIED)}`,
      LOOKED_AT.note,
      "Applied by: a1b2c3d4, moderator",
      `Lifted: ${when(LIFTED)}. Who: c3d4e5f6, admin`,
      `Looked at again: ${when(LOOKED)}. Who: e5f6a7b8, no role now. Note: Not what the rule means`,
    ]);
    expect(lines(await rowOf(BY_KUUTTI.note))).toEqual([
      `Shadow ban · Scraping · ${when(APPLIED)}`,
      BY_KUUTTI.note,
      "Applied by: Kuutti itself, by no person",
    ]);
    // The night lifted the suspension: no person did.
    expect(lines(await rowOf(ENDED.note))).toEqual([
      `Suspension · Misrepresentation · ${when(APPLIED)} · until: ${when(UNTIL)}`,
      ENDED.note,
      "Applied by: a1b2c3d4, moderator",
      `Lifted: ${when(UNTIL)}. Who: Kuutti itself, by no person`,
    ]);
    expect(lines(await rowOf(KEPT.note))).toEqual([
      `Warning · Commercial use · ${when(APPLIED)}`,
      KEPT.note,
      "Applied by: a1b2c3d4, moderator",
      `Looked at again: ${when(LOOKED)}. Who: c3d4e5f6, moderator. Note: Fair`,
    ]);
    expect(lines(await rowOf(OPEN_BAN.note))).toEqual([
      `Ban · Under 18 · ${when(APPLIED)}`,
      OPEN_BAN.note,
      "Applied by: c3d4e5f6, admin",
    ]);
    // Staff by the start of their id only, never the whole of it.
    for (const id of [STAFF, OTHER, GONE]) expect(list).not.toHaveTextContent(id);
  });

  it.each<[ModeratorRole, string[]]>([
    ["moderator", []],
    ["admin", ["Lift", "Look at it again"]],
  ])(
    "offers a lift and a second look only where they can still be done, a ban's to an admin only (%s)",
    async (role, ban) => {
      fetchMock([thePage(), listOf(HISTORY)]);
      show(role);
      expect(buttonsIn(await rowOf(SUSPENDED.note))).toEqual(["Lift", "Look at it again"]);
      expect(buttonsIn(await rowOf(LOOKED_AT.note))).toEqual([]);
      expect(buttonsIn(await rowOf(BY_KUUTTI.note))).toEqual(["Lift", "Look at it again"]);
      expect(buttonsIn(await rowOf(ENDED.note))).toEqual(["Look at it again"]);
      expect(buttonsIn(await rowOf(KEPT.note))).toEqual(["Lift"]);
      expect(buttonsIn(await rowOf(OPEN_BAN.note))).toEqual(ban);
    },
  );

  it("describes each row's buttons by the row's first line, so a screen reader says which sanction", async () => {
    fetchMock([thePage(), listOf(HISTORY)]);
    show("admin");
    const list = (await rowOf(SUSPENDED.note)).closest("ul") as HTMLElement;
    const described = within(list).getAllByRole("button");
    expect(described).toHaveLength(8);
    for (const button of described) {
      const row = button.closest("li") as HTMLElement;
      expect(button).toHaveAccessibleDescription(lines(row)[0] as string);
    }
  });

  const SIGNS_IN =
    "The person may sign in again, unless something else still open stops them. No session comes back: they sign in anew.";
  it.each<[string, ModeratorRole, SanctionEntry, string, string, string]>([
    ["a suspension", "moderator", SUSPENDED, "Lift: Suspension", "Lifted: Suspension.", SIGNS_IN],
    ["a ban", "admin", OPEN_BAN, "Lift: Ban", "Lifted: Ban.", SIGNS_IN],
    [
      "a warning",
      "moderator",
      entry(30, { kind: "warn", endsAt: null, note: "A warning to lift" }),
      "Lift: Warning",
      "Lifted: Warning.",
      "The warning is marked lifted. Nothing else changes for the person.",
    ],
    [
      "a shadow ban",
      "moderator",
      entry(31, { kind: "shadow_ban", endsAt: null, note: "Hidden for a while" }),
      "Lift: Shadow ban",
      "Lifted: Shadow ban.",
      "Others see the person again, unless something else still open hides them. Their sessions are not touched.",
    ],
  ])(
    "lifts %s on its own route after a confirm step, saying what the lift does, then shows who lifted it",
    async (_what, role, item, title, done, effect) => {
      const lifted = { ...item, liftedAt: LOOKED, liftedBy: STAFF, liftedByRole: role };
      const calls = fetchMock([
        thePage(),
        listOf([item], [lifted]),
        on("POST", liftRoute(item), () => json(answerOf(lifted))),
      ]);
      show(role);
      const { button, dialog } = press("Lift", await rowOf(item.note));
      expect(screen.getByRole("dialog", { name: title })).toBe(dialog);
      expect(within(dialog).getByText(effect)).toBeInTheDocument();
      const send = within(dialog).getByRole("button", { name: "Lift" });
      expect(send).toHaveFocus();
      fireEvent.click(send);
      const status = screen.getByRole("status");
      await waitFor(() => expect(status).toHaveTextContent(done));
      expect(screen.queryByRole("dialog")).toBeNull();
      const liftedLine = `Lifted: ${when(LOOKED)}. Who: a1b2c3d4, ${role}`;
      expect(await screen.findByText(liftedLine)).toBeInTheDocument();
      const row = await rowOf(item.note);
      expect(lines(row)[3]).toBe(liftedLine);
      expect(button).not.toBeInTheDocument();
      expect(buttonsIn(row)).toEqual(["Look at it again"]);
      // The button that opened the step is gone with the lift: the status line has the focus.
      expect(status).toHaveFocus();
      expect(asked(calls)).toEqual([
        `GET ${PAGE}`,
        `GET ${LIST}`,
        `POST ${liftRoute(item)}`,
        `GET ${PAGE}`,
        `GET ${LIST}`,
      ]);
      expect(await bodyOf(calls[2])).toBeNull();
    },
  );

  it.each<[string, ModeratorRole, SanctionEntry, "keep" | "lift", string, string, string]>([
    [
      "a suspension, kept",
      "moderator",
      SUSPENDED,
      "keep",
      "Keep it",
      "Look at it again: Suspension",
      "Looked at again: Suspension.",
    ],
    [
      "a ban, lifted",
      "admin",
      OPEN_BAN,
      "lift",
      "Lift it",
      "Look at it again: Ban",
      "Looked at again: Ban.",
    ],
  ])(
    "looks again at %s: a note and a decision, sent on its own route",
    async (_what, role, item, outcome, choice, title, done) => {
      const reviewed = {
        ...item,
        reviewNote: TEXT,
        reviewedBy: GONE,
        reviewedAt: LOOKED,
        reviewedByRole: role,
      };
      const calls = fetchMock([
        thePage(),
        listOf([item], [reviewed]),
        on("POST", reviewRoute(item), () => json(answerOf(reviewed))),
      ]);
      show(role);
      const { dialog } = press("Look at it again", await rowOf(item.note));
      expect(screen.getByRole("dialog", { name: title })).toBe(dialog);
      expect(
        within(dialog).getByText(
          "A second member of staff's look: a note, and keep it or lift it. Whoever applied it cannot.",
        ),
      ).toBeInTheDocument();
      const note = within(dialog).getByRole("textbox", { name: "Your note" });
      expect(note).toHaveFocus();
      expect(note).toHaveAccessibleDescription("Characters: 0/500");
      const decision = within(dialog).getByRole("group", { name: "Decision" });
      const radios = within(decision).getAllByRole("radio");
      expect(radios.map((radio) => radio.closest("label")?.textContent)).toEqual([
        "Keep it",
        "Lift it",
      ]);
      for (const radio of radios) expect(radio).not.toBeChecked();
      const apply = within(dialog).getByRole("button", { name: "Apply" });
      expect(apply).toBeDisabled();

      fireEvent.click(within(decision).getByRole("radio", { name: choice }));
      expect(within(decision).getByRole("radio", { name: choice })).toBeChecked();
      expect(apply).toBeDisabled();
      fireEvent.change(note, { target: { value: "  " } });
      expect(apply).toBeDisabled();
      fireEvent.change(note, { target: { value: `  ${TEXT}  ` } });
      expect(note).toHaveAccessibleDescription(`Characters: ${TEXT.length + 4}/500`);
      expect(apply).toBeEnabled();

      fireEvent.click(apply);
      const status = screen.getByRole("status");
      await waitFor(() => expect(status).toHaveTextContent(done));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(
        await screen.findByText(
          `Looked at again: ${when(LOOKED)}. Who: e5f6a7b8, ${role}. Note: ${TEXT}`,
        ),
      ).toBeInTheDocument();
      expect(buttonsIn(await rowOf(item.note))).toEqual(["Lift"]);
      await waitFor(() => expect(status).toHaveFocus());
      expect(asked(calls)).toEqual([
        `GET ${PAGE}`,
        `GET ${LIST}`,
        `POST ${reviewRoute(item)}`,
        `GET ${PAGE}`,
        `GET ${LIST}`,
      ]);
      expect(await bodyOf(calls[2])).toEqual({ note: TEXT, outcome });
    },
  );

  it("offers no Lift it when looking again at a sanction already lifted", async () => {
    fetchMock([thePage(), listOf([ENDED])]);
    show();
    const { dialog } = press("Look at it again", await rowOf(ENDED.note));
    const decision = within(dialog).getByRole("group", { name: "Decision" });
    expect(
      within(decision)
        .getAllByRole("radio")
        .map((radio) => radio.closest("label")?.textContent),
    ).toEqual(["Keep it"]);
    expect(within(dialog).queryByRole("radio", { name: "Lift it" })).toBeNull();
  });

  it("keeps the rest of the page and the actions when the list's answer is outside the contract", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // An API a version behind the panel: sanctions without the roles now.
    fetchMock([thePage(), on("GET", LIST, () => json({ items: [answerOf(OPEN)] }))]);
    show();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The sanctions could not be loaded.",
    );
    expect(screen.queryByText("The page could not be loaded.")).toBeNull();
    expect(buttonsIn(await actions())).toEqual(MODERATOR_ACTIONS);
  });

  it("sends nothing when an incomplete step's form is submitted anyway", async () => {
    const calls = fetchMock([thePage(), listOf([OPEN])]);
    show();
    // An action with a reason and no note.
    const apply = press("Warn", await actions()).dialog;
    fireEvent.change(within(apply).getByRole("combobox", { name: "Reason" }), {
      target: { value: "harassment" },
    });
    fireEvent.submit(apply.querySelector("form") as HTMLFormElement);
    expect(screen.getByRole("dialog")).toBe(apply);
    fireEvent.click(within(apply).getByRole("button", { name: "Cancel" }));
    // A second look with a note and no decision.
    const review = press("Look at it again", await rowOf(OPEN.note)).dialog;
    fireEvent.change(within(review).getByRole("textbox", { name: "Your note" }), {
      target: { value: TEXT },
    });
    fireEvent.submit(review.querySelector("form") as HTMLFormElement);
    expect(screen.getByRole("dialog")).toBe(review);
    expect(within(review).queryByRole("alert")).toBeNull();
    await act(async () => undefined);
    expect(asked(calls)).toEqual([`GET ${PAGE}`, `GET ${LIST}`]);
  });

  it("keeps the actions when the list cannot be loaded, says so, and an action reads it again", async () => {
    const added = entry(9, { kind: "warn", note: TEXT, endsAt: null });
    fetchMock([
      thePage(),
      on(
        "GET",
        LIST,
        () => failure(500, "internal_error"),
        () => json({ items: [added] }),
      ),
      on("POST", LIST, () => json(answerOf(added), 201)),
    ]);
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The sanctions could not be loaded.",
    );
    expect(buttonsIn(await actions())).toEqual(MODERATOR_ACTIONS);
    expect(screen.queryByRole("list")).toBeNull();
    const { send } = await ready("warn");
    fireEvent.click(send);
    expect(await rowOf(TEXT)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Applied: Warning.");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
