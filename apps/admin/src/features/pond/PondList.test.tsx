import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setTokenSource } from "../../lib/api.ts";
import { PondList } from "./PondList.tsx";

// The ponds and their switches as an admin turns them (#500, ADR-060 §1, §2):
// each pond's state in a word, a confirm step that says the effect, the row
// updated in place, and every refusal in the step's own words. Requests are
// answered by a fake fetch keyed on method and path.

const SUOMI = "3c9d0f5e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const CAPITAL = "7a2d2d5f-0b9f-4b1c-8d4b-1d9e2f3a4b5c";

const pond = (id: string, name: string, matchingOpen: boolean) => ({
  id,
  slug: name.toLowerCase(),
  name,
  nameInessive: `${name}ssa`,
  parentId: null,
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
        <PondList />
      </MemoryRouter>
    </I18nProvider>,
  );
}

const rowOf = async (name: string) =>
  (await screen.findByText(name)).closest("li") as HTMLLIElement;
const step = () => screen.getByRole("dialog");

beforeEach(() => setTokenSource(() => "t".repeat(43)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the ponds", () => {
  it("is busy while it loads, and says what the switch is", async () => {
    fetchMock([listing()]);
    show();
    expect(screen.getByText("Loading the ponds…")).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByText(/Matching in a pond opens when an admin turns it on here/),
    ).toBeInTheDocument();
    await screen.findByRole("list");
    expect(screen.queryByText("Loading the ponds…")).toBeNull();
  });

  it("says each pond's state in a word, and offers the press that changes it", async () => {
    fetchMock([listing(pond(SUOMI, "Suomi", false), pond(CAPITAL, "Pääkaupunkiseutu", true))]);
    show();
    const closed = within(await rowOf("Suomi"));
    expect(closed.getByText("Closed")).toBeInTheDocument();
    expect(closed.getByRole("button", { name: "Suomi: open matching" })).toBeInTheDocument();
    const open = within(await rowOf("Pääkaupunkiseutu"));
    expect(open.getByText("Open")).toBeInTheDocument();
    expect(
      open.getByRole("button", { name: "Pääkaupunkiseutu: close matching" }),
    ).toBeInTheDocument();
    expect(screen.getByText("2 ponds")).toBeInTheDocument();
  });

  it("says one pond in the singular", async () => {
    fetchMock([listing(pond(SUOMI, "Suomi", false))]);
    show();
    expect(await screen.findByText("1 pond")).toBeInTheDocument();
  });

  it.each([
    ["the API fails", () => failure("internal_error", 500)],
    ["the answer is not the contract", () => json({ items: [{ id: "suomi" }] })],
  ])("says the list could not be loaded when %s", async (_, respond) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock([(req) => (isList(req) ? respond() : null)]);
    show();
    expect(await screen.findByText("The ponds could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("reads the list again on Refresh", async () => {
    const calls = fetchMock([listing(pond(SUOMI, "Suomi", false))]);
    show();
    await screen.findByRole("list");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls.filter(isList)).toHaveLength(2));
  });
});

describe("turning the switch", () => {
  it("opens a pond through a confirm step that says the effect, and updates its row in place", async () => {
    const calls = fetchMock([
      listing(pond(SUOMI, "Suomi", false), pond(CAPITAL, "Pääkaupunkiseutu", false)),
      pressing(() => json(pond(SUOMI, "Suomi", true))),
    ]);
    show();
    const row = await rowOf("Suomi");
    const button = within(row).getByRole("button", { name: "Suomi: open matching" });
    button.focus();
    fireEvent.click(button);

    const dialog = within(step());
    expect(dialog.getByRole("heading", { name: "Suomi: open matching?" })).toBeInTheDocument();
    expect(dialog.getByText(/gets a round each night/)).toBeInTheDocument();
    expect(dialog.getByText(/Production builds no rounds yet/)).toBeInTheDocument();
    // Nothing is sent before the step's own button.
    expect(calls.filter(isPress)).toEqual([]);
    fireEvent.click(dialog.getByRole("button", { name: "Open matching" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const press = calls.find(isPress);
    expect(press && path(press)).toBe(`/admin/ponds/${SUOMI}/matching`);
    expect(await press?.clone().json()).toEqual({ open: true });
    expect(within(await rowOf("Suomi")).getByText("Open")).toBeInTheDocument();
    expect(within(await rowOf("Pääkaupunkiseutu")).getByText("Closed")).toBeInTheDocument();
    expect(screen.getByText("Suomi: matching is now open.")).toBeInTheDocument();
    // The row was updated from the answer, never read again.
    expect(calls.filter(isList)).toHaveLength(1);
  });

  it("closes a pond through its own step, which says what stays", async () => {
    const calls = fetchMock([
      listing(pond(SUOMI, "Suomi", true)),
      pressing(() => json(pond(SUOMI, "Suomi", false))),
    ]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Suomi: close matching" }));
    const dialog = within(step());
    expect(dialog.getByRole("heading", { name: "Suomi: close matching?" })).toBeInTheDocument();
    expect(dialog.getByText(/conversations go on/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "Close matching" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await calls.find(isPress)?.clone().json()).toEqual({ open: false });
    expect(screen.getByText("Suomi: matching is now closed.")).toBeInTheDocument();
    expect(within(await rowOf("Suomi")).getByText("Closed")).toBeInTheDocument();
  });

  it("clears what it last said when the next step opens, so the next press is heard", async () => {
    fetchMock([
      listing(pond(SUOMI, "Suomi", false)),
      pressing(() => json(pond(SUOMI, "Suomi", true))),
    ]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Suomi: open matching" }));
    fireEvent.click(within(step()).getByRole("button", { name: "Open matching" }));
    await screen.findByText("Suomi: matching is now open.");
    fireEvent.click(screen.getByRole("button", { name: "Suomi: close matching" }));
    expect(screen.queryByText("Suomi: matching is now open.")).toBeNull();
  });

  it("leaves with nothing sent on Cancel, and gives the focus back", async () => {
    const calls = fetchMock([listing(pond(SUOMI, "Suomi", false))]);
    show();
    const button = await screen.findByRole("button", { name: "Suomi: open matching" });
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
    fetchMock([listing(pond(SUOMI, "Suomi", false)), pressing(respond)]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Suomi: open matching" }));
    fireEvent.click(within(step()).getByRole("button", { name: "Open matching" }));
    expect(
      await within(step()).findByText("That did not go through. Nothing was changed."),
    ).toBeInTheDocument();
    expect(within(await rowOf("Suomi")).getByText("Closed")).toBeInTheDocument();
  });

  it("closes the step on a 403 with no words of its own: the shell says it", async () => {
    fetchMock([
      listing(pond(SUOMI, "Suomi", false)),
      pressing(() => failure("admin_forbidden", 403)),
    ]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Suomi: open matching" }));
    fireEvent.click(within(step()).getByRole("button", { name: "Open matching" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("That did not go through. Nothing was changed.")).toBeNull();
    expect(within(await rowOf("Suomi")).getByText("Closed")).toBeInTheDocument();
  });

  it("sends one request while one is out, however often it is pressed", async () => {
    let answer: (response: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const calls = fetchMock([listing(pond(SUOMI, "Suomi", false)), pressing(() => held)]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Suomi: open matching" }));
    const apply = within(step()).getByRole("button", { name: "Open matching" });
    fireEvent.click(apply);
    await waitFor(() => expect(apply).toHaveAttribute("aria-busy", "true"));
    fireEvent.click(apply);
    answer(json(pond(SUOMI, "Suomi", true)));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter(isPress)).toHaveLength(1);
  });
});
