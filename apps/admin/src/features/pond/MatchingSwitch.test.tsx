import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setTokenSource } from "../../lib/api.ts";
import { MatchingSwitch } from "./MatchingSwitch.tsx";

// The switch that opens matching as an admin turns it (#500, ADR-060 §1, §2):
// its state in a word, a confirm step that says the effect, the state updated
// in place, and every refusal in the step's own words. Requests are answered by
// a fake fetch keyed on method and path.

const SUOMI = "3c9d0f5e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

const pond = (matchingOpen: boolean) => ({
  id: SUOMI,
  slug: "suomi",
  name: "Suomi",
  matchingOpen,
});

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
const isList = (req: Request) => req.method === "GET" && path(req) === "/admin/ponds";
const isPress = (req: Request) => req.method === "POST" && path(req).endsWith("/matching");
const listing =
  (...items: unknown[]): Handler =>
  (req) =>
    isList(req) ? json({ items }) : null;
const pressing =
  (respond: (req: Request) => Response | Promise<Response>): Handler =>
  (req) =>
    isPress(req) ? respond(req) : null;

function show() {
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter>
        <MatchingSwitch />
      </MemoryRouter>
    </I18nProvider>,
  );
}

const step = () => screen.getByRole("dialog");

beforeEach(() => setTokenSource(() => "t".repeat(43)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the switch", () => {
  it("is busy while it loads, then is its state and the press that changes it, nothing explaining them (#581)", async () => {
    fetchMock([listing(pond(false))]);
    show();
    expect(screen.getByText("Loading…")).toHaveAttribute("aria-busy", "true");
    const heading = screen.getByRole("heading", { name: "Matching" });
    await screen.findByRole("button", { name: "Open matching" });
    expect(screen.queryByText("Loading…")).toBeNull();
    // The whole screen: its heading, Refresh, the state in a word and the press.
    expect(heading.closest("section")?.textContent).toBe("MatchingRefreshClosedOpen matching");
  });

  it.each([
    [false, "Closed", "Open matching"],
    [true, "Open", "Close matching"],
  ])(
    "says its state in a word, and offers the press that changes it (%s)",
    async (open, word, press) => {
      fetchMock([listing(pond(open))]);
      show();
      expect(await screen.findByText(word)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: press })).toBeInTheDocument();
      // One switch, so no list and no pond's name to tell it from another.
      expect(screen.queryByRole("list")).toBeNull();
      expect(screen.queryByText("Suomi")).toBeNull();
    },
  );

  it("offers no press when the list holds no pond", async () => {
    const calls = fetchMock([listing()]);
    show();
    await waitFor(() => expect(calls.filter(isList)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(screen.queryByRole("button", { name: "Open matching" })).toBeNull();
  });

  it.each([
    ["the API fails", () => failure("internal_error", 500)],
    ["the answer is not the contract", () => json({ items: [{ id: "suomi" }] })],
  ])("says the switch could not be loaded when %s", async (_, respond) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock([(req) => (isList(req) ? respond() : null)]);
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Could not be loaded\.$/);
    expect(screen.queryByRole("button", { name: "Open matching" })).toBeNull();
  });

  it("reads the switch again on Refresh, and shows what is true now", async () => {
    let open = false;
    const calls = fetchMock([(req) => (isList(req) ? json({ items: [pond(open)] }) : null)]);
    show();
    expect(await screen.findByText("Closed")).toBeInTheDocument();
    open = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Open")).toBeInTheDocument();
    expect(calls.filter(isList)).toHaveLength(2);
  });
});

describe("turning the switch", () => {
  it("opens matching through a confirm step that says the effect, and updates the state in place", async () => {
    const calls = fetchMock([listing(pond(false)), pressing(() => json(pond(true)))]);
    show();
    const button = await screen.findByRole("button", { name: "Open matching" });
    button.focus();
    fireEvent.click(button);

    const dialog = within(step());
    expect(dialog.getByRole("heading", { name: "Open matching?" })).toBeInTheDocument();
    expect(dialog.getByText(/reads their queue from the moment/)).toBeInTheDocument();
    // Nothing is sent before the step's own button.
    expect(calls.filter(isPress)).toEqual([]);
    fireEvent.click(dialog.getByRole("button", { name: "Open matching" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const press = calls.find(isPress);
    expect(press && path(press)).toBe(`/admin/ponds/${SUOMI}/matching`);
    expect(await press?.clone().json()).toEqual({ open: true });
    expect(await screen.findByText("Open")).toBeInTheDocument();
    expect(screen.getByText("Matching is now open.")).toBeInTheDocument();
    // The state was updated from the answer, never read again.
    expect(calls.filter(isList)).toHaveLength(1);
  });

  it("closes matching through its own step, which says what stays", async () => {
    const calls = fetchMock([listing(pond(true)), pressing(() => json(pond(false)))]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Close matching" }));
    const dialog = within(step());
    expect(dialog.getByRole("heading", { name: "Close matching?" })).toBeInTheDocument();
    expect(dialog.getByText(/conversations go on/)).toBeInTheDocument();
    expect(dialog.getByText(/matching has not opened yet/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "Close matching" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await calls.find(isPress)?.clone().json()).toEqual({ open: false });
    expect(screen.getByText("Matching is now closed.")).toBeInTheDocument();
    expect(await screen.findByText("Closed")).toBeInTheDocument();
  });

  it.each([
    ["Matching is now open.", false, "Open matching"],
    ["Matching is now closed.", true, "Close matching"],
  ])(
    "says %s to a screen reader alone, in a live region there before the press (#581)",
    async (words, open, press) => {
      fetchMock([listing(pond(open)), pressing(() => json(pond(!open)))]);
      show();
      const turn = await screen.findByRole("button", { name: press });
      const region = document.querySelector("p[aria-live='polite']");
      expect(region).toBeEmptyDOMElement();
      expect(region).toHaveClass("sr-only");
      fireEvent.click(turn);
      fireEvent.click(within(step()).getByRole("button", { name: press }));
      await waitFor(() => expect(region).toHaveTextContent(words));
      // Never drawn: the badge turns and the button changes its name.
      expect(region).toHaveClass("sr-only");
    },
  );

  it("clears what it last said when the next step opens, so the next press is heard", async () => {
    fetchMock([listing(pond(false)), pressing(() => json(pond(true)))]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Open matching" }));
    fireEvent.click(within(step()).getByRole("button", { name: "Open matching" }));
    await screen.findByText("Matching is now open.");
    fireEvent.click(screen.getByRole("button", { name: "Close matching" }));
    expect(screen.queryByText("Matching is now open.")).toBeNull();
  });

  it("leaves with nothing sent on Cancel, and gives the focus back", async () => {
    const calls = fetchMock([listing(pond(false))]);
    show();
    const button = await screen.findByRole("button", { name: "Open matching" });
    button.focus();
    fireEvent.click(button);
    fireEvent.click(within(step()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button).toHaveFocus();
    expect(calls.filter(isPress)).toEqual([]);
  });

  it.each([
    ["the API fails", () => failure("internal_error", 500)],
    ["the pond is gone", () => failure("not_found", 404)],
    ["the answer is not the contract", () => json({ id: SUOMI })],
  ])("says that it did not go through when %s, and changes nothing", async (_, respond) => {
    fetchMock([listing(pond(false)), pressing(respond)]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Open matching" }));
    fireEvent.click(within(step()).getByRole("button", { name: "Open matching" }));
    expect(
      await within(step()).findByText("That did not go through. Nothing was changed."),
    ).toBeInTheDocument();
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });

  it("closes the step on a 403 with no words of its own: the shell says it", async () => {
    fetchMock([listing(pond(false)), pressing(() => failure("admin_forbidden", 403))]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Open matching" }));
    fireEvent.click(within(step()).getByRole("button", { name: "Open matching" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("That did not go through. Nothing was changed.")).toBeNull();
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });

  it("sends one request while one is out, however often it is pressed", async () => {
    let answer: (response: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const calls = fetchMock([listing(pond(false)), pressing(() => held)]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Open matching" }));
    const apply = within(step()).getByRole("button", { name: "Open matching" });
    fireEvent.click(apply);
    await waitFor(() => expect(apply).toHaveAttribute("aria-busy", "true"));
    fireEvent.click(apply);
    answer(json(pond(true)));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter(isPress)).toHaveLength(1);
  });
});
