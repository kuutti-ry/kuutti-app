import { formatDateTime } from "@kuutti/i18n";
import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setTokenSource } from "../../lib/api.ts";
import { ConfigList } from "./ConfigList.tsx";

// The tunables as an admin uses them (#304, #305): every key with its value
// line and its versions, and a change read by the current value's type, shown
// old and new before it is sent with a reason. Requests are answered by a
// fake fetch keyed on method and path; every POST body is recorded as sent.

const ADMIN = "3c9d0f5e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

const version = (n: number, value: unknown, extra: Record<string, unknown> = {}) => ({
  version: n,
  value,
  validFrom: `2026-10-0${n}T09:30:00.000Z`,
  createdBy: "migration",
  reason: null,
  ...extra,
});
type Version = ReturnType<typeof version>;
const tunable = (key: string, ...versions: [Version, ...Version[]]) => ({
  key,
  value: versions[0].value,
  version: versions[0].version,
  versions,
});

const feedback = tunable(
  "feedback_per_day",
  version(2, 5, { createdBy: ADMIN, reason: "Five is enough for now" }),
  version(1, 3),
);
const pond = tunable("default_pond", version(1, "paakaupunkiseutu"));
const fetches = tunable("photo_fetches_per_day", version(1, { thumb: 600, card: 300, full: 60 }));
const tips = tunable("photo_tips_on", version(1, true));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const failure = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);

type Call = { method: string; path: string; body: unknown; authorization: string | null };
type Handler = (req: Request) => Promise<Response> | Response | null;
function fetchMock(handlers: Handler[]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const text = req.method === "POST" ? await req.clone().text() : "";
      calls.push({
        method: req.method,
        path: path(req),
        body: text ? JSON.parse(text) : undefined,
        authorization: req.headers.get("authorization"),
      });
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
const isList = (req: Request) => req.method === "GET" && path(req) === "/admin/config";
const listOf =
  (...items: unknown[]): Handler =>
  (req) =>
    isList(req) ? json({ items }) : null;
const changeAnswers =
  (answer: (req: Request) => Response | Promise<Response>): Handler =>
  (req) =>
    req.method === "POST" && path(req).startsWith("/admin/config/") ? answer(req) : null;
const posts = (calls: Call[]) => calls.filter((call) => call.method === "POST");
const lists = (calls: Call[]) => calls.filter((call) => call.method === "GET");

function show() {
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter>
        <ConfigList />
      </MemoryRouter>
    </I18nProvider>,
  );
}

/** One key's item in the list, found by its name. */
async function item(key: string) {
  const name = await screen.findByText(key, { selector: "code" });
  const li = name.closest("li");
  if (!li) throw new Error(`no item for ${key}`);
  return within(li);
}

/** Types a value and a reason into one key's form and asks for the review. */
function review(
  at: ReturnType<typeof within>,
  value: string,
  reason = "Because the pilot said so",
) {
  fireEvent.change(at.getByLabelText("New value"), { target: { value } });
  fireEvent.change(at.getByLabelText("Why the change"), { target: { value: reason } });
  fireEvent.click(at.getByRole("button", { name: "Review the change" }));
}

beforeEach(() => setTokenSource(() => "t".repeat(43)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the tunables", () => {
  it("is busy while loading, then lists every key with its value line and its versions", async () => {
    let answer: (res: Response) => void = () => undefined;
    const calls = fetchMock([
      (req) => (isList(req) ? new Promise<Response>((resolve) => (answer = resolve)) : null),
    ]);
    show();
    expect(screen.getByText("Loading the tunables…")).toHaveAttribute("aria-busy", "true");
    await waitFor(() => expect(lists(calls)).toHaveLength(1));
    expect(screen.getByText("Loading the tunables…")).toBeInTheDocument();
    answer(json({ items: [feedback, pond, fetches, tips] }));
    expect(await screen.findByText("4 tunables")).toBeInTheDocument();
    expect(screen.queryByText("Loading the tunables…")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Tunables" })).toBeInTheDocument();
    expect(calls[0]?.authorization).toBe(`Bearer ${"t".repeat(43)}`);

    const lines = screen.getAllByRole("listitem").map((li) => li.querySelector("summary"));
    expect(lines.map((line) => line?.textContent)).toEqual([
      "feedback_per_day version 2: 5",
      "default_pond version 1: paakaupunkiseutu",
      'photo_fetches_per_day version 1: {"thumb":600,"card":300,"full":60}',
      "photo_tips_on version 1: true",
    ]);

    const at = await item("feedback_per_day");
    const table = at.getByRole("table", { name: "Versions, newest first" });
    const header = within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(header).toEqual(["Version", "Value", "From", "By", "Why"]);
    const rows = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      );
    expect(rows).toEqual([
      [
        "2",
        "5",
        formatDateTime("en", new Date("2026-10-02T09:30:00.000Z")),
        ADMIN,
        "Five is enough for now",
      ],
      [
        "1",
        "3",
        formatDateTime("en", new Date("2026-10-01T09:30:00.000Z")),
        "migration",
        "Before reasons were kept",
      ],
    ]);
    // An object's versions show as JSON, like its value line.
    const objectTable = (await item("photo_fetches_per_day")).getByRole("table");
    expect(within(objectTable).getByText('{"thumb":600,"card":300,"full":60}')).toBeInTheDocument();
  });

  it("says one tunable in the singular", async () => {
    fetchMock([listOf(pond)]);
    show();
    expect(await screen.findByText("1 tunable")).toBeInTheDocument();
  });

  it("reloads on refresh", async () => {
    let page = 0;
    const calls = fetchMock([
      (req) => (isList(req) ? json({ items: page++ === 0 ? [pond] : [pond, tips] }) : null),
    ]);
    show();
    expect(await screen.findByText("1 tunable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("2 tunables")).toBeInTheDocument();
    expect(screen.getByText("photo_tips_on", { selector: "code" })).toBeInTheDocument();
    expect(lists(calls)).toHaveLength(2);
  });

  it("says when the tunables could not be loaded", async () => {
    fetchMock([(req) => (isList(req) ? failure("internal_error", 500) : null)]);
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("The tunables could not be loaded.");
    expect(screen.queryByText("Loading the tunables…")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("leaves a refused list to the shell: no list, no failure of its own (#302)", async () => {
    const calls = fetchMock([(req) => (isList(req) ? failure("admin_forbidden", 403) : null)]);
    show();
    await waitFor(() => expect(screen.queryByText("Loading the tunables…")).toBeNull());
    expect(lists(calls)).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Tunables" })).toBeInTheDocument();
  });

  it("labels every control of a key's form", async () => {
    fetchMock([listOf(feedback, pond, fetches)]);
    show();
    const number = await item("feedback_per_day");
    expect(number.getByLabelText("New value")).toHaveValue("5");
    expect(number.getByLabelText("New value")).toHaveAttribute("inputmode", "decimal");
    expect(number.getByLabelText("Why the change")).toHaveValue("");
    expect(number.getByLabelText("Why the change")).toHaveAttribute("maxlength", "500");
    expect(number.getByLabelText("Why the change")).toBeRequired();
    const text = await item("default_pond");
    expect(text.getByLabelText("New value")).toHaveValue("paakaupunkiseutu");
    expect(text.getByLabelText("New value")).toHaveAttribute("inputmode", "text");
    const object = await item("photo_fetches_per_day");
    expect(object.getByLabelText("New value").tagName).toBe("TEXTAREA");
    expect(object.getByLabelText("New value")).toHaveValue('{"thumb":600,"card":300,"full":60}');
  });

  const changed = tunable(
    "feedback_per_day",
    version(3, 7, { createdBy: ADMIN, reason: "More room in the pilot" }),
    ...feedback.versions,
  );

  it("changes a number: reviews old and new, sends exactly the number and the trimmed reason, and reloads", async () => {
    let page = 0;
    const calls = fetchMock([
      (req) => (isList(req) ? json({ items: page++ === 0 ? [feedback] : [changed] }) : null),
      changeAnswers(() => json(changed)),
    ]);
    show();
    const at = await item("feedback_per_day");
    review(at, " 7 ", "  More room in the pilot  ");
    expect(at.getByText("Change feedback_per_day? Now: 5. New: 7")).toBeInTheDocument();
    expect(posts(calls)).toEqual([]);
    expect(at.queryByLabelText("New value")).toBeNull();

    fireEvent.click(at.getByRole("button", { name: "Change it" }));
    await waitFor(() => expect(lists(calls)).toHaveLength(2));
    expect(posts(calls)).toEqual([
      {
        method: "POST",
        path: "/admin/config/feedback_per_day",
        body: { value: 7, reason: "More room in the pilot" },
        authorization: `Bearer ${"t".repeat(43)}`,
      },
    ]);
    const after = await item("feedback_per_day");
    await waitFor(() =>
      expect(
        screen.getByText("feedback_per_day", { selector: "code" }).closest("summary"),
      ).toHaveTextContent("feedback_per_day version 3: 7"),
    );
    expect(after.getAllByRole("row")).toHaveLength(4);
    expect(after.getByLabelText("Why the change")).toHaveValue("");
  });

  it("says the change was saved once the list has reloaded behind it", async () => {
    // The reload is answered when the test says, as a network answers after
    // the panel has drawn its loading state.
    let page = 0;
    let reloaded: (res: Response) => void = () => undefined;
    const calls = fetchMock([
      (req) => {
        if (!isList(req)) return null;
        if (page++ === 0) return json({ items: [feedback] });
        return new Promise<Response>((resolve) => (reloaded = resolve));
      },
      changeAnswers(() => json(changed)),
    ]);
    show();
    const at = await item("feedback_per_day");
    review(at, "7", "More room in the pilot");
    fireEvent.click(at.getByRole("button", { name: "Change it" }));
    await waitFor(() => expect(lists(calls)).toHaveLength(2));
    await screen.findByText("Loading the tunables…");
    reloaded(json({ items: [changed] }));
    expect(await screen.findByText("1 tunable")).toBeInTheDocument();
    expect(await screen.findByText("Saved. feedback_per_day, version 3: 7")).toBeInTheDocument();
  });

  it("holds the buttons while the change is being sent", async () => {
    let answer: (res: Response) => void = () => undefined;
    const calls = fetchMock([
      listOf(feedback),
      changeAnswers(() => new Promise<Response>((resolve) => (answer = resolve))),
    ]);
    show();
    const at = await item("feedback_per_day");
    review(at, "6");
    fireEvent.click(at.getByRole("button", { name: "Change it" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(at.getByRole("button", { name: "Change it" })).toBeDisabled();
    expect(at.getByRole("button", { name: "Cancel" })).toBeDisabled();
    answer(failure("internal_error", 500));
    expect(await at.findByRole("alert")).toHaveTextContent("The change was not saved.");
  });

  it("sends nothing on cancel and goes back to the form as it was", async () => {
    const calls = fetchMock([listOf(feedback), changeAnswers(() => json(feedback))]);
    show();
    const at = await item("feedback_per_day");
    review(at, "9", "Trying it out");
    expect(at.getByRole("button", { name: "Cancel" })).toBeEnabled();
    fireEvent.click(at.getByRole("button", { name: "Cancel" }));
    expect(at.getByLabelText("New value")).toHaveValue("9");
    expect(at.getByLabelText("Why the change")).toHaveValue("Trying it out");
    expect(at.queryByText(/Change feedback_per_day\?/)).toBeNull();
    expect(at.queryByRole("alert")).toBeNull();
    expect(posts(calls)).toEqual([]);
  });

  it("offers the review only with a reason that is more than spaces", async () => {
    fetchMock([listOf(feedback)]);
    show();
    const at = await item("feedback_per_day");
    const submit = at.getByRole("button", { name: "Review the change" });
    expect(submit).toBeDisabled();
    fireEvent.change(at.getByLabelText("Why the change"), { target: { value: "   " } });
    expect(submit).toBeDisabled();
    fireEvent.change(at.getByLabelText("Why the change"), { target: { value: "A" } });
    expect(submit).toBeEnabled();
  });

  describe("refuses an input that is not a number for a number key, and sends nothing", () => {
    it.each([
      ["a word", "seven"],
      ["empty", ""],
      ["spaces only", "   "],
      ["not finite", "Infinity"],
      ["not a number", "NaN"],
      ["two numbers", "1 2"],
    ])("%s", async (_, input) => {
      const calls = fetchMock([listOf(feedback)]);
      show();
      const at = await item("feedback_per_day");
      review(at, input);
      expect(at.getByRole("alert")).toHaveTextContent("This is not a value of the key's type.");
      expect(at.queryByRole("button", { name: "Change it" })).toBeNull();
      expect(at.getByLabelText("New value")).toHaveValue(input);
      expect(posts(calls)).toEqual([]);
    });
  });

  it("reads a decimal and an exponent as numbers, and the error goes once the input is one", async () => {
    const calls = fetchMock([
      listOf(feedback),
      changeAnswers(() =>
        json(tunable("feedback_per_day", version(3, 1000), ...feedback.versions)),
      ),
    ]);
    show();
    const at = await item("feedback_per_day");
    review(at, "seven");
    expect(at.getByRole("alert")).toBeInTheDocument();
    review(at, "0.5");
    expect(at.getByText("Change feedback_per_day? Now: 5. New: 0.5")).toBeInTheDocument();
    fireEvent.click(at.getByRole("button", { name: "Cancel" }));
    expect(at.queryByRole("alert")).toBeNull();
    review(at, "1e3");
    fireEvent.click(at.getByRole("button", { name: "Change it" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]?.body).toStrictEqual({
      value: 1000,
      reason: "Because the pilot said so",
    });
  });

  it("sends a string for a string key, even when it reads as a number", async () => {
    const calls = fetchMock([
      listOf(pond),
      changeAnswers(() => json(tunable("default_pond", version(2, "12"), ...pond.versions))),
    ]);
    show();
    const at = await item("default_pond");
    review(at, " 12 ");
    expect(at.getByText("Change default_pond? Now: paakaupunkiseutu. New: 12")).toBeInTheDocument();
    fireEvent.click(at.getByRole("button", { name: "Change it" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({
      path: "/admin/config/default_pond",
      body: { value: "12", reason: "Because the pilot said so" },
    });
  });

  it("refuses an empty string for a string key", async () => {
    const calls = fetchMock([listOf(pond)]);
    show();
    const at = await item("default_pond");
    review(at, "  ");
    expect(at.getByRole("alert")).toHaveTextContent("This is not a value of the key's type.");
    expect(posts(calls)).toEqual([]);
  });

  describe("takes only true or false for a boolean key", () => {
    it.each([
      ["false", false],
      [" true ", true],
    ])("sends %j as a boolean", async (input, value) => {
      const calls = fetchMock([
        listOf(tips),
        changeAnswers(() => json(tunable("photo_tips_on", version(2, value), ...tips.versions))),
      ]);
      show();
      const at = await item("photo_tips_on");
      review(at, input);
      expect(
        at.getByText(`Change photo_tips_on? Now: true. New: ${String(value)}`),
      ).toBeInTheDocument();
      fireEvent.click(at.getByRole("button", { name: "Change it" }));
      await waitFor(() => expect(posts(calls)).toHaveLength(1));
      expect(posts(calls)[0]?.body).toStrictEqual({ value, reason: "Because the pilot said so" });
    });

    it.each([["yes"], ["True"], ["1"], [""]])("refuses %j", async (input) => {
      const calls = fetchMock([listOf(tips)]);
      show();
      const at = await item("photo_tips_on");
      review(at, input);
      expect(at.getByRole("alert")).toHaveTextContent("This is not a value of the key's type.");
      expect(posts(calls)).toEqual([]);
    });
  });

  it("sends the parsed object for an object key, from a textarea of JSON", async () => {
    const next = { thumb: 600, card: 300, full: 80 };
    const calls = fetchMock([
      listOf(fetches),
      changeAnswers(() =>
        json(tunable("photo_fetches_per_day", version(2, next), ...fetches.versions)),
      ),
    ]);
    show();
    const at = await item("photo_fetches_per_day");
    review(at, ' { "thumb": 600, "card": 300, "full": 80 } ');
    expect(
      at.getByText(
        'Change photo_fetches_per_day? Now: {"thumb":600,"card":300,"full":60}. New: {"thumb":600,"card":300,"full":80}',
      ),
    ).toBeInTheDocument();
    fireEvent.click(at.getByRole("button", { name: "Change it" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({
      path: "/admin/config/photo_fetches_per_day",
      body: { value: next, reason: "Because the pilot said so" },
    });
  });

  describe("refuses what is not a JSON object for an object key, and sends nothing", () => {
    it.each([
      ["invalid JSON", '{"thumb": 600,'],
      ["an array", "[600, 300, 60]"],
      ["null", "null"],
      ["a number", "600"],
      ["a string", '"thumb"'],
      ["empty", ""],
    ])("%s", async (_, input) => {
      const calls = fetchMock([listOf(fetches)]);
      show();
      const at = await item("photo_fetches_per_day");
      review(at, input);
      expect(at.getByRole("alert")).toHaveTextContent("This is not a value of the key's type.");
      expect(at.getByLabelText("New value")).toHaveValue(input);
      expect(posts(calls)).toEqual([]);
    });
  });

  describe("says what the API refused, back at the form, without reloading", () => {
    it.each([
      [
        "config_shape",
        () => failure("config_shape", 400),
        "The value must keep the current one's type and keys.",
      ],
      [
        "config_conflict",
        () => failure("config_conflict", 409),
        "Another admin changed this key meanwhile. Refresh and look again.",
      ],
      ["another 400", () => failure("validation_failed", 400), "The change was not saved."],
      ["a 404", () => failure("not_found", 404), "The change was not saved."],
      ["a 500", () => failure("internal_error", 500), "The change was not saved."],
      [
        "an answer without the envelope",
        () => new Response("bad gateway", { status: 502 }),
        "The change was not saved.",
      ],
      [
        "a network failure",
        () => {
          throw new TypeError("Failed to fetch");
        },
        "The change was not saved.",
      ],
    ])("%s", async (_, answer, text) => {
      const calls = fetchMock([listOf(feedback), changeAnswers(answer)]);
      show();
      const at = await item("feedback_per_day");
      review(at, "6", "Pilot week two");
      fireEvent.click(at.getByRole("button", { name: "Change it" }));
      expect(await at.findByRole("alert")).toHaveTextContent(text);
      expect(at.getAllByRole("alert")).toHaveLength(1);
      expect(at.getByLabelText("New value")).toHaveValue("6");
      expect(at.getByLabelText("Why the change")).toHaveValue("Pilot week two");
      expect(at.getByRole("button", { name: "Review the change" })).toBeEnabled();
      expect(at.queryByText(/^Saved\./)).toBeNull();
      expect(posts(calls)).toHaveLength(1);
      expect(lists(calls)).toHaveLength(1);
    });
  });

  it("leaves a refused change to the shell: back at the form with no failure of its own (#302)", async () => {
    const calls = fetchMock([
      listOf(feedback),
      changeAnswers(() => failure("admin_forbidden", 403)),
    ]);
    show();
    const at = await item("feedback_per_day");
    review(at, "6", "Pilot week two");
    fireEvent.click(at.getByRole("button", { name: "Change it" }));
    expect(await at.findByLabelText("New value")).toHaveValue("6");
    expect(at.getByLabelText("Why the change")).toHaveValue("Pilot week two");
    expect(at.getByRole("button", { name: "Review the change" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(lists(calls)).toHaveLength(1);
  });
});
