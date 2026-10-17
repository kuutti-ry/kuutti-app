import type { ChatMessage, ConversationDetail } from "@kuutti/schema";
import { act, fireEvent, screen, userEvent, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { FakeWebSocket } from "@/test/websocket";
import { ConversationScreen } from "./ConversationScreen";
import { ChatLiveProvider } from "./store";
import { dayOf, timeOf } from "./time";

// One conversation (#348): the header, the messages by day with who, when and
// what, "Read", the read mark, the composer with its count, Send, the
// optimistic row, the refusals in words with the words kept, the resend with
// the same id, the archived banner, the closed states, earlier messages, and
// the reads on focus; live (#349): what the socket brings, marked read only
// in front, the read mark, Online, the state, the sending row swapped by its
// id, the connection line.

jest.mock("nativewind", () => ({
  ...jest.requireActual("nativewind"),
  useColorScheme: () => ({ colorScheme: "light", setColorScheme: jest.fn() }),
}));

const {
  __router: router,
  __focus: focus,
  __blur: blur,
} = jest.requireMock("expo-router") as {
  __router: { back: jest.Mock };
  __focus: () => void;
  __blur: () => void;
};
const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const tokens = {
  sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  accessToken: token("access"),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: token("refresh"),
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
const noProblems = () =>
  expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual([]);

const ID = "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a70";
const DAY_1 = "2026-10-16T07:59:00.000Z";
const DAY_1_LATER = "2026-10-16T08:00:00.000Z";
const DAY_2 = "2026-10-17T11:03:00.000Z";
const DAY_2_LATER = "2026-10-17T11:05:00.000Z";

const message = (
  seq: number,
  side: "mine" | "theirs",
  body: string,
  createdAt = DAY_2,
): ChatMessage => ({
  id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
  seq,
  side,
  kind: "text",
  body,
  createdAt,
  clientId: null,
});
const detail = (over: Partial<ConversationDetail> = {}): ConversationDetail => ({
  id: ID,
  state: "open",
  closedHow: null,
  counterpart: { deleted: false, name: "Sanna", age: 31, thumb: null },
  lastMessage: null,
  unread: 0,
  limits: { maxLength: 30 },
  counterpartReadUpTo: 0,
  ...over,
});

type Call = { method: string; path: string; query: string; body: unknown };
type Route = (call: Call) => Response | Promise<Response>;
/** The API as the screen sees it: every call recorded, answered by the route. */
function api(route: Route): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === "GET" ? "" : await request.text();
    const call = {
      method: request.method,
      path: url.pathname,
      query: url.search,
      body: text ? JSON.parse(text) : null,
    };
    calls.push(call);
    return route(call);
  }) as unknown as typeof fetch;
  return calls;
}
/** A conversation with these messages, newest first as the API pages them, and these answers to a send. */
function conversation(
  shown: ConversationDetail,
  pages: ChatMessage[][],
  onSend: (call: Call) => Response | Promise<Response> = () => refusal("internal_error", 500),
): Call[] {
  let page = 0;
  return api((call) => {
    if (call.method === "GET" && call.path === `/conversations/${ID}`) return json(shown);
    if (call.method === "GET" && call.path === `/conversations/${ID}/messages`) {
      const messages = pages[Math.min(page, pages.length - 1)] ?? [];
      page += 1;
      return json({ messages });
    }
    if (call.method === "POST" && call.path === `/conversations/${ID}/messages`)
      return onSend(call);
    if (call.method === "POST" && call.path === `/conversations/${ID}/read`) {
      return new Response(null, { status: 204 });
    }
    return refusal("not_found", 404);
  });
}
const composer = () => screen.getByLabelText("Message");
const type = (words: string) =>
  act(async () => {
    fireEvent.changeText(composer(), words);
  });
const sendButton = () => screen.getByRole("button", { name: "Send" });
const press = async (name: string) => {
  await userEvent.setup().press(screen.getByRole("button", { name }));
  await settle();
};
const said = (who: string, at: string, text: string) =>
  screen.getByLabelText(`${who}, ${timeOf("en", at)}, ${text}`);

let ids: string[];
beforeEach(async () => {
  store.clear();
  router.back.mockReset();
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ];
  jest.spyOn(globalThis.expo, "uuidv4").mockImplementation(() => ids.shift() ?? "x");
  await clearSession();
  await saveSession(tokens);
});
afterEach(() => jest.restoreAllMocks());

describe("one conversation", () => {
  it("shows the counterpart, the messages by day with who, when and what, Read under the last one read, and marks them read", async () => {
    const calls = conversation(detail({ counterpartReadUpTo: 2 }), [
      [
        message(4, "theirs", "Kiva!", DAY_2_LATER),
        message(3, "mine", "Lähdetään", DAY_2),
        message(2, "mine", "Hei", DAY_1_LATER),
        message(1, "theirs", "Moi", DAY_1),
      ],
    ]);
    await renderWithTheme(<ConversationScreen id={ID} />);
    expect(await screen.findByLabelText(`Sanna, ${timeOf("en", DAY_1)}, Moi`)).toBeTruthy();
    expectPinnedHeader("Sanna, 31", "Back");
    expect(said("You", DAY_1_LATER, "Hei")).toBeTruthy();
    expect(said("You", DAY_2, "Lähdetään")).toBeTruthy();
    expect(said("Sanna", DAY_2_LATER, "Kiva!")).toBeTruthy();
    expect(screen.getByText(dayOf("en", DAY_1))).toBeTruthy();
    expect(screen.getByText(dayOf("en", DAY_2))).toBeTruthy();
    // "Read" under the second, the last of A's that B has read; once.
    expect(screen.getAllByText("Read")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Earlier messages" })).toBeNull();
    expect(screen.getByText("30 characters left")).toBeTruthy();
    expect(sendButton().props.accessibilityState?.disabled).toBe(true);
    await waitFor(() =>
      expect(calls.filter((c) => c.path.endsWith("/read"))).toEqual([
        { method: "POST", path: `/conversations/${ID}/read`, query: "", body: { upTo: 4 } },
      ]),
    );
    noProblems();
    // A new size of the list keeps the newest in sight.
    const scroll = screen.getByTestId("messages");
    await act(async () => {
      fireEvent(scroll, "contentSizeChange", 390, 2000);
    });
    await press("Back");
    expect(router.back).toHaveBeenCalled();
  });

  it("shows a message at once as sending, swaps it for the answer, and leaves the composer empty", async () => {
    let answer: (response: Response) => void = () => undefined;
    const calls = conversation(
      detail(),
      [[message(1, "theirs", "Moi", DAY_1)]],
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    await type("  Nähdään!  ");
    expect(screen.getByText("22 characters left")).toBeTruthy();
    expect(sendButton().props.accessibilityState?.disabled).toBe(false);
    await userEvent.setup().press(sendButton());
    expect(screen.getByText("Sending…")).toBeTruthy();
    expect(composer().props.value).toBe("");
    expect(calls.find((c) => c.method === "POST" && c.path.endsWith("/messages"))?.body).toEqual({
      clientId: "11111111-1111-4111-8111-111111111111",
      body: "Nähdään!",
    });
    await act(async () => answer(json(message(2, "mine", "Nähdään!", DAY_2), 201)));
    await settle();
    expect(screen.queryByText("Sending…")).toBeNull();
    expect(said("You", DAY_2, "Nähdään!")).toBeTruthy();
  });

  it("says each refusal in words under the composer and keeps the words", async () => {
    const answers = [
      refusal("contact_details", 400),
      refusal("message_too_long", 400),
      refusal("message_budget_exceeded", 429),
    ];
    const calls = conversation(detail(), [[]], () => answers.shift() ?? refusal("x", 500));
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    for (const [words, text] of [
      [
        "Soita 040 123 4567",
        "A message cannot carry an e-mail address, a link, a phone number or a social media handle.",
      ],
      ["Pitkä viesti", "The message is too long. Make it shorter and send it again."],
      ["Taas", "You are sending messages very fast. Wait a moment and send again."],
    ] as const) {
      await type(words);
      await userEvent.setup().press(sendButton());
      await settle();
      expect(screen.getByText(text)).toBeTruthy();
      expect(composer().props.value).toBe(words);
    }
    // Typing takes the refusal away.
    await type("Taas uudestaan");
    expect(
      screen.queryByText("You are sending messages very fast. Wait a moment and send again."),
    ).toBeNull();
    // Nothing was read: there was nothing of theirs.
    expect(calls.filter((c) => c.path.endsWith("/read"))).toEqual([]);
  });

  it("keeps the words after a failure and sends them again with the same id", async () => {
    let tries = 0;
    const calls = conversation(detail(), [[]], (call) => {
      tries += 1;
      if (tries === 1) throw new TypeError("Network request failed");
      return json(message(1, "mine", (call.body as { body: string }).body), 201);
    });
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    await type("Hei");
    await userEvent.setup().press(sendButton());
    await settle();
    expect(
      screen.getByText("The message was not sent. Check your connection and send it again."),
    ).toBeTruthy();
    expect(composer().props.value).toBe("Hei");
    await userEvent.setup().press(sendButton());
    await settle();
    const sends = calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
    expect(sends.map((c) => (c.body as { clientId: string }).clientId)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(said("You", DAY_2, "Hei")).toBeTruthy();
    // A new message after it takes a new id.
    await type("Mitä kuuluu?");
    await userEvent.setup().press(sendButton());
    await settle();
    const last = calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages")).at(-1);
    expect(last?.body).toMatchObject({ clientId: "22222222-2222-4222-8222-222222222222" });
  });

  it("says the end in words when the conversation closed while the person wrote", async () => {
    let closed = false;
    api((call) => {
      if (call.method === "GET" && call.path === `/conversations/${ID}`) {
        return json(closed ? detail({ state: "closed", closedHow: "unmatch" }) : detail());
      }
      if (call.method === "GET") return json({ messages: [] });
      closed = true;
      return refusal("conversation_closed", 409);
    });
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    await type("Oletko siellä?");
    await userEvent.setup().press(sendButton());
    await settle();
    expect(
      screen.getByText("This conversation has ended, so the message was not sent."),
    ).toBeTruthy();
    expect(screen.getByText("This conversation has ended.")).toBeTruthy();
    expect(screen.queryByLabelText("Message")).toBeNull();
  });

  it("counts down and stops Send past the longest message", async () => {
    conversation(detail({ limits: { maxLength: 5 } }), [[]]);
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    await type("12345");
    expect(screen.getByText("0 characters left")).toBeTruthy();
    expect(sendButton().props.accessibilityState?.disabled).toBe(false);
    await type("123456");
    expect(
      screen.getByText("The message is too long. Make it shorter and send it again."),
    ).toBeTruthy();
    expect(sendButton().props.accessibilityState?.disabled).toBe(true);
  });

  it("says that writing brings an archived conversation back, and leaves the archive when it does", async () => {
    conversation(detail({ state: "archived" }), [[message(1, "theirs", "Moi", DAY_1)]], (call) =>
      json(message(2, "mine", (call.body as { body: string }).body), 201),
    );
    await renderWithTheme(<ConversationScreen id={ID} />);
    expect(
      await screen.findByText("This conversation was quiet for a week. Write to bring it back."),
    ).toBeTruthy();
    await type("Hei taas");
    await userEvent.setup().press(sendButton());
    await settle();
    expect(
      screen.queryByText("This conversation was quiet for a week. Write to bring it back."),
    ).toBeNull();
  });

  it("says how a closed conversation ended instead of the composer, under Deleted user once the person left", async () => {
    conversation(
      detail({ state: "closed", closedHow: "erasure", counterpart: { deleted: true } }),
      [[message(1, "theirs", "Moi", DAY_1)]],
    );
    await renderWithTheme(<ConversationScreen id={ID} />);
    expect(await screen.findByText("This person deleted their account.")).toBeTruthy();
    expectPinnedHeader("Deleted user", "Back");
    expect(said("Deleted user", DAY_1, "Moi")).toBeTruthy();
    expect(screen.queryByLabelText("Message")).toBeNull();
    noProblems();
  });

  it("loads earlier messages with a button while a page back came full, and says when it cannot", async () => {
    // The newest page is full: fifty messages, 51 down to 2.
    const newest = Array.from({ length: 50 }, (_, i) =>
      message(51 - i, i % 2 === 0 ? "theirs" : "mine", `Viesti ${51 - i}`),
    );
    let earlier = 0;
    api((call) => {
      if (call.method === "GET" && call.path === `/conversations/${ID}`) return json(detail());
      if (call.method === "GET" && call.query.includes("before=2")) {
        earlier += 1;
        return earlier === 1
          ? refusal("internal_error", 500)
          : json({ messages: [message(1, "theirs", "Yksi")] });
      }
      if (call.method === "GET") return json({ messages: newest });
      return new Response(null, { status: 204 });
    });
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText(`Sanna, ${timeOf("en", DAY_2)}, Viesti 51`);
    await press("Earlier messages");
    expect(screen.getByText("The conversation could not be loaded.")).toBeTruthy();
    await press("Earlier messages");
    expect(said("Sanna", DAY_2, "Yksi")).toBeTruthy();
    expect(said("You", DAY_2, "Viesti 2")).toBeTruthy();
    // A short page back: nothing more to ask for.
    expect(screen.queryByRole("button", { name: "Earlier messages" })).toBeNull();
  });

  it("offers no earlier messages after a short page, whatever the first one's number", async () => {
    // The first message the person may read is the fourth: the ones before it are not theirs to read.
    conversation(detail(), [[message(5, "theirs", "Viisi"), message(4, "mine", "Neljä")]]);
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText(`Sanna, ${timeOf("en", DAY_2)}, Viisi`);
    expect(screen.queryByRole("button", { name: "Earlier messages" })).toBeNull();
  });

  it("reads what is new on focus, onward from the newest it holds, and marks it read", async () => {
    let reads = 0;
    const calls = api((call) => {
      if (call.method === "GET" && call.path === `/conversations/${ID}`) return json(detail());
      if (call.method === "GET" && call.query.includes("after=1")) {
        return json({ messages: [message(2, "theirs", "Oletko siellä?", DAY_2_LATER)] });
      }
      if (call.method === "GET") return json({ messages: [message(1, "theirs", "Moi", DAY_2)] });
      reads += 1;
      // The first mark fails: the next look marks again.
      return reads === 1 ? refusal("internal_error", 500) : new Response(null, { status: 204 });
    });
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText(`Sanna, ${timeOf("en", DAY_2)}, Moi`);
    await settle();
    await act(async () => focus());
    expect(
      await screen.findByLabelText(`Sanna, ${timeOf("en", DAY_2_LATER)}, Oletko siellä?`),
    ).toBeTruthy();
    await settle();
    expect(
      calls.filter((c) => c.method === "GET" && c.path.endsWith("/messages")).map((c) => c.query),
    ).toEqual(["", "?after=1&limit=100"]);
    expect(calls.filter((c) => c.path.endsWith("/read")).map((c) => c.body)).toEqual([
      { upTo: 1 },
      { upTo: 2 },
    ]);
  });

  it("says a conversation that is gone, under the way back", async () => {
    api(() => refusal("not_found", 404));
    await renderWithTheme(<ConversationScreen id={ID} />);
    expect(await screen.findByText("This conversation is no longer available.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Conversations" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("offers Try again when the conversation did not load", async () => {
    let first = true;
    conversation(detail(), [[message(1, "theirs", "Moi", DAY_1)]]);
    const ok = globalThis.fetch;
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      if (first) {
        first = false;
        return refusal("internal_error", 500);
      }
      return ok(input, init);
    }) as unknown as typeof fetch;
    await renderWithTheme(<ConversationScreen id={ID} />);
    expect(await screen.findByText("The conversation could not be loaded.")).toBeTruthy();
    await press("Try again");
    expect(said("Sanna", DAY_1, "Moi")).toBeTruthy();
  });
});

describe("one conversation, live over the socket", () => {
  const ONLINE = "Online";
  const LOST = "Connection lost. Reconnecting…";
  const mine = (seq: number, body: string, clientId: string): ChatMessage => ({
    ...message(seq, "mine", body, DAY_2_LATER),
    clientId,
  });
  /** The screen under the live provider, with its socket made. */
  async function live(...args: Parameters<typeof conversation>): Promise<Call[]> {
    const calls = conversation(...args);
    await renderWithTheme(
      <ChatLiveProvider>
        <ConversationScreen id={ID} />
      </ChatLiveProvider>,
    );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    return calls;
  }
  const ready = () =>
    act(async () => {
      FakeWebSocket.latest().open();
      FakeWebSocket.latest().receive({ type: "ready" });
    });
  const frame = (sent: unknown) => act(async () => FakeWebSocket.latest().receive(sent));

  beforeEach(() => FakeWebSocket.install());
  afterEach(() => jest.useRealTimers());

  it("joins what the socket brings and marks it read, says Read and Online from its frames, and resumes from the newest it holds", async () => {
    const calls = await live(detail(), [
      [message(2, "mine", "Hei", DAY_2), message(1, "theirs", "Moi", DAY_1)],
    ]);
    await screen.findByLabelText(`Sanna, ${timeOf("en", DAY_1)}, Moi`);
    await ready();
    expect(FakeWebSocket.latest().sent.at(-1)).toEqual({
      type: "resume",
      conversations: [{ id: ID, seq: 2 }],
    });
    expect(screen.queryByText("Read")).toBeNull();
    expect(screen.queryByText(ONLINE)).toBeNull();
    await frame({ type: "read", conversationId: ID, upTo: 2 });
    expect(screen.getByText("Read")).toBeTruthy();
    await frame({ type: "presence", conversationId: ID, online: true });
    expect(screen.getByText(ONLINE)).toBeTruthy();
    noProblems();
    await frame({
      type: "message",
      conversationId: ID,
      message: message(3, "theirs", "Oletko siellä?", DAY_2_LATER),
    });
    expect(said("Sanna", DAY_2_LATER, "Oletko siellä?")).toBeTruthy();
    await settle();
    expect(calls.filter((c) => c.path.endsWith("/read")).map((c) => c.body)).toEqual([
      { upTo: 2 },
      { upTo: 3 },
    ]);
    await frame({ type: "presence", conversationId: ID, online: false });
    expect(screen.queryByText(ONLINE)).toBeNull();
  });

  it("marks nothing read while another screen is over it, and reads up to the newest on coming back", async () => {
    const calls = await live(detail(), [[message(1, "theirs", "Moi", DAY_1)], []]);
    await screen.findByLabelText(`Sanna, ${timeOf("en", DAY_1)}, Moi`);
    await ready();
    await settle();
    await act(async () => blur());
    await frame({
      type: "message",
      conversationId: ID,
      message: message(2, "theirs", "Oletko siellä?", DAY_2_LATER),
    });
    expect(said("Sanna", DAY_2_LATER, "Oletko siellä?")).toBeTruthy();
    await settle();
    const reads = () => calls.filter((c) => c.path.endsWith("/read")).map((c) => c.body);
    expect(reads()).toEqual([{ upTo: 1 }]);
    await act(async () => focus());
    await settle();
    expect(reads()).toEqual([{ upTo: 1 }, { upTo: 2 }]);
  });

  it("follows the conversation's state from the socket: archived, closed with no Online, and gone", async () => {
    await live(detail(), [[message(1, "theirs", "Moi", DAY_1)]]);
    await screen.findByLabelText("Message");
    await ready();
    await frame({ type: "presence", conversationId: ID, online: true });
    await frame({ type: "conversation", conversationId: ID, state: "archived", closedHow: null });
    expect(
      screen.getByText("This conversation was quiet for a week. Write to bring it back."),
    ).toBeTruthy();
    expect(screen.getByText(ONLINE)).toBeTruthy();
    await frame({
      type: "conversation",
      conversationId: ID,
      state: "closed",
      closedHow: "unmatch",
    });
    expect(screen.getByText("This conversation has ended.")).toBeTruthy();
    expect(screen.queryByLabelText("Message")).toBeNull();
    expect(screen.queryByText(ONLINE)).toBeNull();
    await frame({ type: "conversation", conversationId: ID, state: "gone", closedHow: null });
    expect(screen.getByText("This conversation is no longer available.")).toBeTruthy();
    expect(screen.queryByLabelText(`Sanna, ${timeOf("en", DAY_1)}, Moi`)).toBeNull();
  });

  it("swaps the sending row for the message the socket brought with its id, and counts a lost answer as sent when the socket brought it", async () => {
    const answers: Array<{ resolve: (r: Response) => void; reject: (e: unknown) => void }> = [];
    await live(
      detail(),
      [[message(1, "theirs", "Moi", DAY_1)]],
      () =>
        new Promise<Response>((resolve, reject) => {
          answers.push({ resolve, reject });
        }),
    );
    await screen.findByLabelText("Message");
    await ready();
    await type("Nähdään!");
    await userEvent.setup().press(sendButton());
    expect(screen.getByText("Sending…")).toBeTruthy();
    const first = mine(2, "Nähdään!", "11111111-1111-4111-8111-111111111111");
    await frame({ type: "message", conversationId: ID, message: first });
    // Before the API's answer: the socket's copy carries the phone's id.
    expect(screen.queryByText("Sending…")).toBeNull();
    expect(screen.getAllByLabelText(`You, ${timeOf("en", DAY_2_LATER)}, Nähdään!`)).toHaveLength(1);
    await act(async () => answers[0]?.resolve(json(first, 201)));
    await settle();
    expect(screen.getAllByLabelText(`You, ${timeOf("en", DAY_2_LATER)}, Nähdään!`)).toHaveLength(1);

    await type("Huomenna");
    await userEvent.setup().press(sendButton());
    await frame({
      type: "message",
      conversationId: ID,
      message: mine(3, "Huomenna", "22222222-2222-4222-8222-222222222222"),
    });
    await act(async () => answers[1]?.reject(new TypeError("Network request failed")));
    await settle();
    // The answer was lost, the message was not: no refusal, nothing put back.
    expect(
      screen.queryByText("The message was not sent. Check your connection and send it again."),
    ).toBeNull();
    expect(composer().props.value).toBe("");
    expect(said("You", DAY_2_LATER, "Huomenna")).toBeTruthy();
  });

  it("says the connection is lost at the top, politely, until the socket is open again", async () => {
    await live(detail(), [[message(1, "theirs", "Moi", DAY_1)]]);
    await screen.findByLabelText("Message");
    await ready();
    expect(screen.queryByText(LOST)).toBeNull();
    jest.useFakeTimers();
    await act(async () => FakeWebSocket.latest().drop());
    expect(screen.getByText(LOST).props.accessibilityLiveRegion).toBe("polite");
    await act(() => jest.advanceTimersByTimeAsync(1000));
    expect(FakeWebSocket.instances).toHaveLength(2);
    await ready();
    expect(screen.queryByText(LOST)).toBeNull();
  });
});
