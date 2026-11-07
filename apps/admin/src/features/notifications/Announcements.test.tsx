import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setTokenSource } from "../../lib/api.ts";
import { Announcements, draftOf } from "./Announcements.tsx";

// The announcements as admins write, approve and delete them (#573, ADR-068
// §2): English and Finnish required, Swedish whole or not at all and its
// absence said in words; the writer offered no approval; a confirm step that
// says what sending does, to how many; and every refusal in words. Requests
// are answered by a fake fetch keyed on method and path.

const EN = { title: "A short break on Sunday", body: "Kuutti is closed from 10 to 12." };
const FI = { title: "Lyhyt tauko sunnuntaina", body: "Kuutti on suljettu kello 10–12." };
const SV = { title: "Ett kort avbrott på söndag", body: "Kuutti är stängd klockan 10–12." };
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const announcement = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n),
  en: EN,
  fi: FI,
  sv: null,
  writtenAt: "2026-11-07T10:00:00.000Z",
  approvedAt: null,
  yours: false,
  ...over,
});
const REACH = { accounts: 120, phones: 1, addresses: 40 };

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
      calls.push(req.clone());
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
const key = (req: Request) => `${req.method} ${path(req)}`;
const listing =
  (items: unknown[], reach = REACH): Handler =>
  (req) =>
    key(req) === "GET /admin/announcements" ? json({ items, reach }) : null;
const on =
  (
    method: string,
    pathname: string,
    respond: (req: Request) => Response | Promise<Response>,
  ): Handler =>
  (req) =>
    key(req) === `${method} ${pathname}` ? respond(req) : null;

function show() {
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter>
        <Announcements />
      </MemoryRouter>
    </I18nProvider>,
  );
}

const field = (legend: string, label: "Title" | "Text") =>
  within(screen.getByRole("group", { name: legend })).getByLabelText(label);
function fill(legend: string, words: { title: string; body: string }) {
  fireEvent.change(field(legend, "Title"), { target: { value: words.title } });
  fireEvent.change(field(legend, "Text"), { target: { value: words.body } });
}
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save for a second admin" }));
const listOf = (heading: string) =>
  screen.getByRole("heading", { name: heading }).closest("section") as HTMLElement;

beforeEach(() => setTokenSource(() => "t".repeat(43)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the lists", () => {
  it("shows what waits and what was sent, each in its languages, Swedish's absence in words", async () => {
    fetchMock([
      listing([
        announcement(1),
        announcement(2, { yours: true, sv: SV }),
        announcement(3, { approvedAt: "2026-11-06T09:00:00.000Z" }),
      ]),
    ]);
    show();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    const waiting = await waitFor(() => listOf("Waiting for a second admin"));
    // What waits comes first, then the form, then what was sent.
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Waiting for a second admin",
      "Write an announcement",
      "Sent",
    ]);
    const drafts = within(waiting).getAllByRole("listitem");
    expect(drafts).toHaveLength(2);
    // Another admin's draft: Approve and Delete.
    expect(
      within(drafts[0] as HTMLElement).getByRole("button", { name: "Approve and send" }),
    ).toBeInTheDocument();
    expect(
      within(drafts[0] as HTMLElement).getByText("Not written: Swedish readers get the English."),
    ).toBeInTheDocument();
    // The reader's own: no Approve, and why, in words.
    const own = drafts[1] as HTMLElement;
    expect(within(own).queryByRole("button", { name: "Approve and send" })).toBeNull();
    expect(
      within(own).getByText("You wrote this, so another admin approves it."),
    ).toBeInTheDocument();
    expect(within(own).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(within(own).getByText(SV.title)).toBeInTheDocument();
    // What was sent: its words and when, and nothing to press.
    const sent = within(listOf("Sent")).getAllByRole("listitem");
    expect(sent).toHaveLength(1);
    expect(within(sent[0] as HTMLElement).queryAllByRole("button")).toEqual([]);
    expect(within(sent[0] as HTMLElement).getByText(/^Sent /)).toBeInTheDocument();
    for (const words of [EN.title, EN.body, FI.title, FI.body]) {
      expect(within(sent[0] as HTMLElement).getByText(words)).toBeInTheDocument();
    }
  });

  it("says when nothing waits and nothing was sent", async () => {
    fetchMock([listing([])]);
    show();
    expect(await screen.findByText("Nothing is waiting.")).toBeInTheDocument();
    expect(screen.getByText("Nothing has been sent yet.")).toBeInTheDocument();
  });

  it("says the list could not be loaded, with no form to write in", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock([on("GET", "/admin/announcements", () => failure("internal_error", 500))]);
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Could not be loaded\.$/);
    expect(screen.queryByRole("button", { name: "Save for a second admin" })).toBeNull();
  });
});

describe("writing one", () => {
  it("saves English and Finnish as a draft that waits, clears the form and says so", async () => {
    let sentBody: unknown;
    fetchMock([
      listing([]),
      on("POST", "/admin/announcements", async (req) => {
        sentBody = await req.json();
        return json(announcement(4, { yours: true }), 201);
      }),
    ]);
    show();
    await screen.findByText("Nothing is waiting.");
    // Swedish is optional, and the form says who reads the English instead.
    expect(
      screen.getByText(
        "People who read Kuutti in Swedish get the English when there is no Swedish.",
      ),
    ).toBeInTheDocument();
    fill("English", EN);
    fill("Finnish", FI);
    save();
    expect(
      await screen.findByText("Saved. It waits for another admin's approval."),
    ).toBeInTheDocument();
    expect(sentBody).toEqual({ en: EN, fi: FI });
    const waiting = within(listOf("Waiting for a second admin")).getAllByRole("listitem");
    expect(
      within(waiting[0] as HTMLElement).getByText("You wrote this, so another admin approves it."),
    ).toBeInTheDocument();
    expect(field("English", "Title")).toHaveValue("");
    expect(field("Finnish", "Text")).toHaveValue("");
  });

  it("sends the Swedish too when it is whole", async () => {
    let sentBody: unknown;
    fetchMock([
      listing([]),
      on("POST", "/admin/announcements", async (req) => {
        sentBody = await req.json();
        return json(announcement(5, { yours: true, sv: SV }), 201);
      }),
    ]);
    show();
    await screen.findByText("Nothing is waiting.");
    fill("English", EN);
    fill("Finnish", FI);
    fill("Swedish, if you write it", SV);
    save();
    await screen.findByText("Saved. It waits for another admin's approval.");
    expect(sentBody).toEqual({ en: EN, fi: FI, sv: SV });
  });

  it.each([
    [
      "no Finnish",
      () => fill("English", EN),
      "Write a title and a text in English and in Finnish.",
    ],
    [
      "half a Swedish text",
      () => {
        fill("English", EN);
        fill("Finnish", FI);
        fireEvent.change(field("Swedish, if you write it", "Title"), {
          target: { value: SV.title },
        });
      },
      "Swedish needs a title and a text, or neither.",
    ],
  ])("refuses %s before sending anything", async (_, enter, words) => {
    const calls = fetchMock([listing([])]);
    show();
    await screen.findByText("Nothing is waiting.");
    enter();
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(words);
    expect(calls.map(key)).toEqual(["GET /admin/announcements"]);
  });

  it.each([
    [
      "text_contact_details",
      400,
      "An announcement cannot carry an e-mail address, a link, a phone number or a handle.",
    ],
    [
      "validation_failed",
      400,
      "The announcement was not accepted: a title is at most 80 characters and a text at most 1,000.",
    ],
    ["internal_error", 500, "That did not go through. Try again."],
  ] as const)(
    "says the API's refusal %s in words and keeps what was written",
    async (code, status, words) => {
      fetchMock([listing([]), on("POST", "/admin/announcements", () => failure(code, status))]);
      show();
      await screen.findByText("Nothing is waiting.");
      fill("English", EN);
      fill("Finnish", FI);
      save();
      expect(await screen.findByRole("alert")).toHaveTextContent(words);
      expect(field("English", "Title")).toHaveValue(EN.title);
    },
  );

  it("holds each title to 80 characters and each text to 1,000 as they are typed", async () => {
    fetchMock([listing([])]);
    show();
    await screen.findByText("Nothing is waiting.");
    expect(field("English", "Title")).toHaveAttribute("maxLength", "80");
    expect(field("Swedish, if you write it", "Text")).toHaveAttribute("maxLength", "1000");
    expect(field("Finnish", "Title")).toBeRequired();
    expect(field("Swedish, if you write it", "Title")).not.toBeRequired();
  });
});

describe("approving one", () => {
  it("says what sending does and to how many, sends it, and moves it to the sent", async () => {
    const calls = fetchMock([
      listing([announcement(1)]),
      on("POST", `/admin/announcements/${id(1)}/approve`, () =>
        json(announcement(1, { approvedAt: "2026-11-07T11:00:00.000Z" })),
      ),
    ]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Approve and send" }));
    const step = screen.getByRole("dialog", { name: "Send this announcement to everybody?" });
    expect(step).toHaveTextContent(
      "It goes now to every account as a notice in the app (120 accounts), by e-mail to 40 confirmed addresses, and as a push to 1 person, or once the quiet hours end if they hold. Nothing takes it back.",
    );
    expect(within(step).getByText(EN.title)).toBeInTheDocument();
    fireEvent.click(within(step).getByRole("button", { name: "Send to everybody" }));
    expect(await screen.findByText("Sent to everybody.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.map(key)).toContain(`POST /admin/announcements/${id(1)}/approve`);
    expect(screen.getByText("Nothing is waiting.")).toBeInTheDocument();
    expect(within(listOf("Sent")).getAllByRole("listitem")).toHaveLength(1);
  });

  it("sends nothing on Cancel", async () => {
    const calls = fetchMock([listing([announcement(1)])]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Approve and send" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.map(key)).toEqual(["GET /admin/announcements"]);
  });

  it.each([
    ["own_announcement", "You wrote this announcement, so another admin approves it."],
    ["announcement_sent", "This announcement went to everybody already."],
  ])("says the API's refusal %s in the step", async (code, words) => {
    fetchMock([
      listing([announcement(1)]),
      on("POST", `/admin/announcements/${id(1)}/approve`, () => failure(code, 409)),
    ]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Approve and send" }));
    const step = screen.getByRole("dialog");
    fireEvent.click(within(step).getByRole("button", { name: "Send to everybody" }));
    expect(await within(step).findByRole("alert")).toHaveTextContent(words);
    expect(screen.queryByText("Sent to everybody.")).toBeNull();
  });
});

describe("deleting a draft", () => {
  it("says it goes for good, deletes it and says so", async () => {
    fetchMock([
      listing([announcement(1, { yours: true })]),
      on("DELETE", `/admin/announcements/${id(1)}`, () => new Response(null, { status: 204 })),
    ]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const step = screen.getByRole("dialog", { name: "Delete this draft?" });
    expect(step).toHaveTextContent("Nobody has been told of it. It goes for good.");
    fireEvent.click(within(step).getByRole("button", { name: "Delete the draft" }));
    expect(await screen.findByText("Deleted.")).toBeInTheDocument();
    expect(screen.getByText("Nothing is waiting.")).toBeInTheDocument();
  });

  it.each([
    [409, "announcement_sent", "This announcement went to everybody already."],
    [500, "internal_error", "That did not go through. Try again."],
  ] as const)(
    "says a refusal (%s) in the step and keeps the draft",
    async (status, code, words) => {
      fetchMock([
        listing([announcement(1)]),
        on("DELETE", `/admin/announcements/${id(1)}`, () => failure(code, status)),
      ]);
      show();
      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
      const step = screen.getByRole("dialog");
      fireEvent.click(within(step).getByRole("button", { name: "Delete the draft" }));
      expect(await within(step).findByRole("alert")).toHaveTextContent(words);
      fireEvent.click(within(step).getByRole("button", { name: "Cancel" }));
      expect(within(listOf("Waiting for a second admin")).getAllByRole("listitem")).toHaveLength(1);
    },
  );
});

describe("draftOf", () => {
  const empty = { title: "", body: "" };

  it("takes English and Finnish, and Swedish whole or not at all", () => {
    expect(draftOf({ en: EN, fi: FI, sv: empty })).toEqual({ en: EN, fi: FI });
    expect(draftOf({ en: EN, fi: FI, sv: SV })).toEqual({ en: EN, fi: FI, sv: SV });
  });

  it.each([
    ["no English", { en: empty, fi: FI, sv: empty }, "missing"],
    ["a Finnish title of spaces", { en: EN, fi: { ...FI, title: "  " }, sv: empty }, "missing"],
    [
      "a Swedish title alone",
      { en: EN, fi: FI, sv: { title: SV.title, body: " " } },
      "swedishHalf",
    ],
    ["a Swedish text alone", { en: EN, fi: FI, sv: { title: "", body: SV.body } }, "swedishHalf"],
  ] as const)("refuses %s", (_, draft, problem) => {
    expect(draftOf(draft)).toBe(problem);
  });
});
