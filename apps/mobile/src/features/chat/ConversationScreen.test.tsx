import type { ChatMessage, ChatPhoto, ConversationDetail } from "@kuutti/schema";
import { act, fireEvent, screen, userEvent, waitFor } from "@testing-library/react-native";
import * as ImagePicker from "expo-image-picker";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { AccessibilityInfo, AppState, Platform } from "react-native";
import { pickPrepared } from "@/features/media";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { FakeWebSocket } from "@/test/websocket";
import { FakeXhr, partsOf } from "@/test/xhr";
import { ConversationScreen } from "./ConversationScreen";
import { ChatLiveProvider } from "./store";
import { dayOf, timeOf } from "./time";

// One conversation (#348): the header, the messages by day with who, when and
// what, "Read", the read mark, the composer with its count, Send, the
// optimistic row, the refusals in words with the words kept, the resend with
// the same id, the archived banner, the closed states, earlier messages, and
// the reads on focus; live (#349): what the socket brings, marked read only
// in front, the read mark, Online, the state, the sending row swapped by its
// id, the connection line; a photo (#350): attached, sent with its caption and
// its progress, refused in words, sent again with its id, the picker's
// outcomes, the bubble's three states and the reads again for its URLs.

jest.mock("nativewind", () => ({
  ...jest.requireActual("nativewind"),
  useColorScheme: () => ({ colorScheme: "light", setColorScheme: jest.fn() }),
}));
// The chain before an upload runs as it is, on the picker and the manipulator
// of jest.setup.js; a test may hand in the on-device check's refusal instead.
jest.mock("@/features/media", () => {
  const actual = jest.requireActual("@/features/media");
  return { ...actual, pickPrepared: jest.fn(actual.pickPrepared) };
});

const {
  __router: router,
  __focus: focus,
  __blur: blur,
} = jest.requireMock("expo-router") as {
  __router: { back: jest.Mock; push: jest.Mock };
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
  photo: null,
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

const idOf = (seq: number) => `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
const BLURHASH = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";
const PHOTO_ID = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01";
const urls = (n: number) => ({
  thumb: `https://media.test/${n}/thumb.webp?sig=s`,
  full: `https://media.test/${n}/full.webp?sig=s`,
  expiresAt: "2030-01-01T00:15:00.000Z",
});
/** A photo message (#350), signed for its reader unless told otherwise; null for one whose photo went. */
const photoMessage = (
  seq: number,
  side: "mine" | "theirs",
  caption: string | null,
  photo: Partial<ChatPhoto> | null = {},
  createdAt = DAY_2,
): ChatMessage => ({
  ...message(seq, side, "", createdAt),
  kind: "photo",
  body: caption,
  photo: photo && {
    photoId: PHOTO_ID,
    blurhash: BLURHASH,
    width: 1600,
    height: 1067,
    description: null,
    urls: urls(seq),
    ...photo,
  },
});
const launch = ImagePicker.launchImageLibraryAsync as jest.Mock;
/** The next pick hands back this picture from the library. */
const picks = (uri = "file:///roll/1.jpg") =>
  launch.mockResolvedValueOnce({ canceled: false, assets: [{ uri, width: 3000, height: 2000 }] });
/** What expo-image's host view was handed as its source (a list); the pictures are hidden, their bubbles say them. */
const sourceOf = (testID: string) =>
  (
    screen.getByTestId(testID, { includeHiddenElements: true }).props as {
      source?: Array<{ uri?: string; cacheKey?: string }>;
    }
  ).source?.[0];
const ATTACHED = "Photo attached. The words in the field go under it.";
const attached = () => screen.queryByText(ATTACHED);

/** An upload the test answers itself, so the sending row can be seen on the way. */
class SteppedXhr extends FakeXhr {
  static all: SteppedXhr[] = [];
  target = "";
  override open(method: string, url: string): void {
    super.open(method, url);
    this.target = url;
  }
  override send(body: FormData | null): void {
    FakeXhr.sent.push({ method: "POST", url: this.target, headers: {}, body });
    SteppedXhr.all.push(this);
  }
  progress(loaded: number, total: number): void {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  answer(status: number, body: unknown): void {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
  fail(): void {
    this.onerror?.();
  }
}
const uploads = () => SteppedXhr.all;
/** A sent upload's multipart parts: each field's name and its text, or the picture's file. */
const fieldsOf = (n: number) =>
  partsOf(FakeXhr.sent[n]).map((part) => [part.fieldName, part.string ?? part.uri]);

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
  router.push.mockReset();
  launch.mockReset();
  launch.mockResolvedValue({ canceled: true, assets: null });
  (pickPrepared as jest.Mock).mockImplementation(
    jest.requireActual("@/features/media").pickPrepared,
  );
  FakeXhr.install();
  (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = SteppedXhr;
  SteppedXhr.all = [];
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
    expect(screen.queryByRole("button", { name: "Add photo" })).toBeNull();
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
  const FAILED = "The message was not sent. Check your connection and send it again.";
  const announced = () =>
    (AccessibilityInfo.announceForAccessibility as jest.Mock).mock.calls.map(([words]) => words);
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

  it("takes back the refusal when the socket brings a message whose answer was lost, and the words unless they were changed", async () => {
    await live(detail(), [[message(1, "theirs", "Moi", DAY_1)]], () =>
      Promise.reject(new TypeError("Network request failed")),
    );
    await screen.findByLabelText("Message");
    await ready();
    await type("Nähdään!");
    await userEvent.setup().press(sendButton());
    await settle();
    expect(screen.getByText(FAILED)).toBeTruthy();
    expect(composer().props.value).toBe("Nähdään!");
    await frame({
      type: "message",
      conversationId: ID,
      message: mine(2, "Nähdään!", "11111111-1111-4111-8111-111111111111"),
    });
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(composer().props.value).toBe("");
    expect(said("You", DAY_2_LATER, "Nähdään!")).toBeTruthy();
    // Words changed meanwhile are the person's: they stay.
    await type("Huomenna");
    await userEvent.setup().press(sendButton());
    await settle();
    await type("Huomenna kuudelta");
    await frame({
      type: "message",
      conversationId: ID,
      message: mine(3, "Huomenna", "22222222-2222-4222-8222-222222222222"),
    });
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(composer().props.value).toBe("Huomenna kuudelta");
  });

  it("joins only what the socket brought from the oldest message shown on", async () => {
    await live(detail(), [
      [message(6, "theirs", "Kuusi", DAY_2), message(5, "theirs", "Viisi", DAY_2)],
    ]);
    await screen.findByLabelText(`Sanna, ${timeOf("en", DAY_2)}, Viisi`);
    await ready();
    await frame({
      type: "message",
      conversationId: ID,
      message: message(2, "theirs", "Kaksi", DAY_1),
    });
    await frame({
      type: "message",
      conversationId: ID,
      message: message(7, "theirs", "Seitsemän", DAY_2_LATER),
    });
    expect(screen.queryByLabelText(`Sanna, ${timeOf("en", DAY_1)}, Kaksi`)).toBeNull();
    expect(said("Sanna", DAY_2_LATER, "Seitsemän")).toBeTruthy();
  });

  it("marks nothing read while the app is inactive, and reads what came when it is active again", async () => {
    const listeners: Array<(state: string) => void> = [];
    jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
      listeners.push(listener as (state: string) => void);
      return { remove: jest.fn() } as never;
    });
    const was = AppState.currentState;
    const calls = await live(detail(), [
      [message(1, "theirs", "Moi", DAY_1)],
      [message(2, "theirs", "Oletko siellä?", DAY_2_LATER)],
    ]);
    const reads = () => calls.filter((c) => c.path.endsWith("/read")).map((c) => c.body);
    try {
      await screen.findByLabelText(`Sanna, ${timeOf("en", DAY_1)}, Moi`);
      await ready();
      await settle();
      (AppState as { currentState: unknown }).currentState = "inactive";
      await frame({
        type: "message",
        conversationId: ID,
        message: message(2, "theirs", "Oletko siellä?", DAY_2_LATER),
      });
      await settle();
      expect(reads()).toEqual([{ upTo: 1 }]);
      (AppState as { currentState: unknown }).currentState = "active";
      await act(async () => {
        for (const listener of listeners) listener("active");
      });
      await settle();
      expect(reads()).toEqual([{ upTo: 1 }, { upTo: 2 }]);
    } finally {
      (AppState as { currentState: unknown }).currentState = was;
    }
  });

  it("tells VoiceOver once that the connection is lost, iOS having no live regions", async () => {
    (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
    jest.replaceProperty(Platform, "OS", "ios");
    await live(detail(), [[message(1, "theirs", "Moi", DAY_1)]]);
    await screen.findByLabelText("Message");
    await ready();
    jest.useFakeTimers();
    await act(async () => FakeWebSocket.latest().drop());
    expect(announced()).toEqual([LOST]);
    // Still lost after the next try: said once.
    await act(() => jest.advanceTimersByTimeAsync(1000));
    await act(async () => FakeWebSocket.latest().drop());
    expect(announced()).toEqual([LOST]);
  });

  it("leaves the lost connection to the live region on Android", async () => {
    (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
    jest.replaceProperty(Platform, "OS", "android");
    await live(detail(), [[message(1, "theirs", "Moi", DAY_1)]]);
    await screen.findByLabelText("Message");
    await ready();
    await act(async () => FakeWebSocket.latest().drop());
    expect(screen.getByText(LOST).props.accessibilityLiveRegion).toBe("polite");
    expect(announced()).toEqual([]);
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
  it("swaps the sending photo for the socket's copy by its id, reads nothing while its answer is due, and keeps the answer's URLs (#350)", async () => {
    const calls = await live(detail(), [[message(1, "theirs", "Moi", DAY_1)]]);
    await screen.findByLabelText("Message");
    await ready();
    picks();
    await press("Add photo");
    await type("Mökillä");
    await userEvent.setup().press(sendButton());
    const bare = {
      ...photoMessage(2, "mine", "Mökillä", { urls: null }, DAY_2_LATER),
      clientId: "11111111-1111-4111-8111-111111111111",
    };
    await frame({ type: "message", conversationId: ID, message: bare });
    expect(screen.queryByText(/^Sending…/)).toBeNull();
    const name = `You, ${timeOf("en", DAY_2_LATER)}, Mökillä`;
    expect(screen.getAllByRole("button", { name })).toHaveLength(1);
    await settle();
    const rereads = () => calls.filter((c) => c.query.includes("limit=1"));
    expect(rereads()).toEqual([]);
    await act(async () => uploads()[0]?.answer(201, photoMessage(2, "mine", "Mökillä")));
    await settle();
    expect(sourceOf(`photo-${idOf(2)}`)?.uri).toBe(urls(2).thumb);
    // Another frame joins what is shown: the socket's copy never takes the URLs away.
    await frame({
      type: "message",
      conversationId: ID,
      message: message(3, "theirs", "Kiva!", DAY_2_LATER),
    });
    expect(said("Sanna", DAY_2_LATER, "Kiva!")).toBeTruthy();
    expect(sourceOf(`photo-${idOf(2)}`)?.uri).toBe(urls(2).thumb);
    expect(rereads()).toEqual([]);
  });

  it("reads a photo the socket brought again over HTTP for its URLs, once (#350)", async () => {
    const calls = api((call) => {
      if (call.method === "GET" && call.path === `/conversations/${ID}`) return json(detail());
      if (call.query === "?after=1&limit=1") {
        return json({ messages: [photoMessage(2, "theirs", "Katso")] });
      }
      if (call.method === "GET") return json({ messages: [message(1, "theirs", "Moi", DAY_1)] });
      return new Response(null, { status: 204 });
    });
    await renderWithTheme(
      <ChatLiveProvider>
        <ConversationScreen id={ID} />
      </ChatLiveProvider>,
    );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await screen.findByLabelText("Message");
    await ready();
    await frame({
      type: "message",
      conversationId: ID,
      message: photoMessage(2, "theirs", "Katso", { urls: null }),
    });
    expect(
      screen.getByRole("button", { name: `Sanna, ${timeOf("en", DAY_2)}, Katso` }),
    ).toBeTruthy();
    await waitFor(() => expect(sourceOf(`photo-${idOf(2)}`)?.uri).toBe(urls(2).thumb));
    await frame({
      type: "message",
      conversationId: ID,
      message: message(3, "theirs", "Kiva!", DAY_2_LATER),
    });
    await settle();
    expect(sourceOf(`photo-${idOf(2)}`)?.uri).toBe(urls(2).thumb);
    expect(calls.filter((c) => c.query.includes("limit=1")).map((c) => c.query)).toEqual([
      "?after=1&limit=1",
    ]);
  });

  // The look on focus is held open while the socket brings a photo and its
  // URLs are read again; the page then comes without it, and must not take
  // the URLs away, as a copy of what was held from before the page did.
  it.each([
    {
      what: "what is new",
      first: [message(1, "theirs", "Moi", DAY_1)],
      held: "?after=1&limit=100",
      seq: 2,
    },
    { what: "the first page of an empty conversation", first: [], held: "", seq: 1 },
  ])(
    "keeps the URLs of a photo read again while the look on focus for $what was on its way (#350)",
    async ({ first, held, seq }) => {
      let page: (response: Response) => void = () => undefined;
      let looks = 0;
      const calls = api((call) => {
        if (call.method === "GET" && call.path === `/conversations/${ID}`) return json(detail());
        if (call.query === `?after=${seq - 1}&limit=1`) {
          return json({ messages: [photoMessage(seq, "theirs", "Katso")] });
        }
        if (call.method === "GET" && call.path === `/conversations/${ID}/messages`) {
          looks += 1;
          if (looks === 1) return json({ messages: first });
          return new Promise<Response>((resolve) => {
            page = resolve;
          });
        }
        return new Response(null, { status: 204 });
      });
      await renderWithTheme(
        <ChatLiveProvider>
          <ConversationScreen id={ID} />
        </ChatLiveProvider>,
      );
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      await screen.findByLabelText("Message");
      await ready();
      await act(async () => focus());
      const pages = () =>
        calls.filter((c) => c.path.endsWith("/messages") && !c.query.endsWith("&limit=1"));
      await waitFor(() => expect(pages().map((c) => c.query)).toEqual(["", held]));
      await frame({
        type: "message",
        conversationId: ID,
        message: photoMessage(seq, "theirs", "Katso", { urls: null }),
      });
      await waitFor(() => expect(sourceOf(`photo-${idOf(seq)}`)?.uri).toBe(urls(seq).thumb));
      await act(async () => page(json({ messages: [] })));
      await settle();
      expect(sourceOf(`photo-${idOf(seq)}`)?.uri).toBe(urls(seq).thumb);
      expect(calls.filter((c) => c.query.endsWith("&limit=1")).map((c) => c.query)).toEqual([
        `?after=${seq - 1}&limit=1`,
      ]);
    },
  );

  it("takes the photo off when the socket brings the message whose answer was lost, unless another was attached since (#350)", async () => {
    await live(detail(), [[message(1, "theirs", "Moi", DAY_1)]]);
    await screen.findByLabelText("Message");
    await ready();
    picks();
    await press("Add photo");
    await type("Hei");
    await userEvent.setup().press(sendButton());
    await act(async () => uploads()[0]?.fail());
    await settle();
    expect(screen.getByText(FAILED)).toBeTruthy();
    expect(attached()).toBeTruthy();
    await frame({
      type: "message",
      conversationId: ID,
      message: {
        ...photoMessage(2, "mine", "Hei", { urls: null }),
        clientId: "11111111-1111-4111-8111-111111111111",
      },
    });
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(attached()).toBeNull();
    expect(composer().props.value).toBe("");

    picks("file:///roll/2.jpg");
    await press("Add photo");
    await type("Taas");
    await userEvent.setup().press(sendButton());
    await act(async () => uploads()[1]?.fail());
    await settle();
    picks("file:///roll/3.jpg");
    await press("Add photo");
    await frame({
      type: "message",
      conversationId: ID,
      message: {
        ...photoMessage(3, "mine", "Taas", { urls: null }),
        clientId: "22222222-2222-4222-8222-222222222222",
      },
    });
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(sourceOf("photo-attached")?.uri).toBe("file:///roll/3.jpg#resized");
  });
});

describe("a photo in a conversation (#350)", () => {
  const FAILED = "The message was not sent. Check your connection and send it again.";
  const ONE = "11111111-1111-4111-8111-111111111111";
  const description = {
    people: 1,
    setting: "outdoors" as const,
    scene: ["lake" as const],
    objects: ["hiking" as const, "dog" as const],
    smile: true,
    glasses: false,
    sunglasses: true,
    facialHair: false,
  };
  const WORDS =
    "Automatic description: One person, outdoors, by a lake. Smiling, sunglasses. Hiking, with a dog.";

  it("attaches a picked photo, sends it with the words as its caption and its progress, swaps it for the answer, and opens it full size", async () => {
    const calls = conversation(detail(), [[message(1, "theirs", "Moi", DAY_1)]]);
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    noProblems();
    picks();
    await press("Add photo");
    expect(attached()?.props.accessibilityLiveRegion).toBe("polite");
    expect(sourceOf("photo-attached")?.uri).toBe("file:///roll/1.jpg#resized");
    // A photo goes without words.
    expect(sendButton().props.accessibilityState?.disabled).toBe(false);
    noProblems();
    await type("Mökillä");
    await userEvent.setup().press(sendButton());
    expect(screen.getByText("Sending… 0 %").props.accessibilityLiveRegion).toBe("polite");
    expect(screen.getByLabelText(/^You, .+, Mökillä$/)).toBeTruthy();
    expect(sourceOf("photo-sending")?.uri).toBe("file:///roll/1.jpg#resized");
    expect(attached()).toBeNull();
    expect(composer().props.value).toBe("");
    expect(
      screen.getByRole("button", { name: "Add photo" }).props.accessibilityState?.disabled,
    ).toBe(true);
    expect(FakeXhr.sent[0]?.url).toBe(`http://localhost:3000/conversations/${ID}/photos`);
    expect(fieldsOf(0)).toEqual([
      ["clientId", ONE],
      ["caption", "Mökillä"],
      ["photo", "file:///roll/1.jpg#resized"],
    ]);
    await act(async () => uploads()[0]?.progress(1, 2));
    expect(screen.getByText("Sending… 50 %")).toBeTruthy();
    await act(async () =>
      uploads()[0]?.answer(201, { ...photoMessage(2, "mine", "Mökillä"), clientId: ONE }),
    );
    await settle();
    expect(screen.queryByText(/^Sending…/)).toBeNull();
    const bubble = screen.getByRole("button", { name: `You, ${timeOf("en", DAY_2)}, Mökillä` });
    expect(bubble.props.accessibilityHint).toBe("Opens the photo full size");
    expect(sourceOf(`photo-${idOf(2)}`)).toMatchObject({
      uri: urls(2).thumb,
      cacheKey: `${PHOTO_ID}/thumb`,
    });
    noProblems();
    await press(`You, ${timeOf("en", DAY_2)}, Mökillä`);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/chats/photo/[messageId]",
      params: { messageId: idOf(2), conversation: ID, seq: "2", blurhash: BLURHASH },
    });
    // Signed in the answer: nothing was read again.
    expect(calls.filter((c) => c.query.includes("limit=1"))).toEqual([]);
  });

  it("sends a photo without words, said as Photo, and Remove photo takes one off before", async () => {
    conversation(detail(), [[]]);
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    picks();
    await press("Add photo");
    await press("Remove photo");
    expect(attached()).toBeNull();
    expect(sendButton().props.accessibilityState?.disabled).toBe(true);
    picks("file:///roll/2.jpg");
    await press("Add photo");
    await userEvent.setup().press(sendButton());
    expect(screen.getByLabelText(/^You, .+, Photo$/)).toBeTruthy();
    expect(fieldsOf(0)).toEqual([
      ["clientId", ONE],
      ["photo", "file:///roll/2.jpg#resized"],
    ]);
    await act(async () =>
      uploads()[0]?.answer(201, { ...photoMessage(1, "mine", null), clientId: ONE }),
    );
    await settle();
    expect(screen.getByRole("button", { name: `You, ${timeOf("en", DAY_2)}, Photo` })).toBeTruthy();
  });

  it("says each refusal in words under the field and keeps the words, taking off a picture the check, the day or the file refused", async () => {
    conversation(detail(), [[]]);
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    const refusals = [
      [
        "photo_rejected_nudity",
        400,
        "Not sent. Photos with nudity cannot be sent on Kuutti.",
        false,
      ],
      [
        "photo_rejected_violence",
        400,
        "Not sent. Photos with violence or weapons cannot be sent on Kuutti.",
        false,
      ],
      [
        "photo_rejected_other",
        400,
        "Not sent. This photo cannot be sent on Kuutti; try another one.",
        false,
      ],
      [
        "message_photo_budget_exceeded",
        429,
        "You have tried to send many photos today. You can send photos again after midnight.",
        false,
      ],
      [
        "photo_unsupported",
        415,
        "This file is not a photo Kuutti can use. Choose a JPEG, PNG or WebP picture.",
        false,
      ],
      ["photo_invalid", 422, "The photo could not be read. Try another picture.", false],
      ["photo_too_many_pixels", 422, "The photo is too large. Choose a smaller picture.", false],
      ["payload_too_large", 413, "The photo is too large. Choose a smaller picture.", false],
      ["media_unavailable", 503, "Photos are not available right now.", false],
      [
        "contact_details",
        400,
        "A message cannot carry an e-mail address, a link, a phone number or a social media handle.",
        true,
      ],
      [
        "message_too_long",
        400,
        "The message is too long. Make it shorter and send it again.",
        true,
      ],
      [
        "message_budget_exceeded",
        429,
        "You are sending messages very fast. Wait a moment and send again.",
        true,
      ],
      [
        "media_busy",
        503,
        "Many photos are being processed right now. Try again in a moment.",
        true,
      ],
    ] as const;
    for (const [code, status, words, keeps] of refusals) {
      if (!attached()) {
        picks();
        await press("Add photo");
      }
      await type("Kuvateksti");
      await userEvent.setup().press(sendButton());
      await act(async () =>
        uploads()
          .at(-1)
          ?.answer(status, { error: { code, message: "x", requestId: "r" } }),
      );
      await settle();
      expect([code, screen.getByText(words).props.accessibilityLiveRegion]).toEqual([
        code,
        "assertive",
      ]);
      expect(composer().props.value).toBe("Kuvateksti");
      expect([code, attached() !== null]).toEqual([code, keeps]);
    }
  });

  it("keeps the photo and its id after a failure and sends them again; without the photo, the words take a new id", async () => {
    const calls = conversation(detail(), [[]], (call) =>
      json(
        { ...message(3, "mine", "Taas"), clientId: (call.body as { clientId: string }).clientId },
        201,
      ),
    );
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    picks();
    await press("Add photo");
    await type("Hei");
    await userEvent.setup().press(sendButton());
    await act(async () => uploads()[0]?.fail());
    await settle();
    expect(screen.getByText(FAILED)).toBeTruthy();
    expect(composer().props.value).toBe("Hei");
    expect(attached()).toBeTruthy();
    await userEvent.setup().press(sendButton());
    expect(fieldsOf(1)).toEqual(fieldsOf(0));
    await act(async () =>
      uploads()[1]?.answer(200, { ...photoMessage(1, "mine", "Hei"), clientId: ONE }),
    );
    await settle();
    expect(screen.getByRole("button", { name: `You, ${timeOf("en", DAY_2)}, Hei` })).toBeTruthy();
    expect(attached()).toBeNull();

    // A failure, then the photo taken off: the same words alone are a new message.
    picks("file:///roll/2.jpg");
    await press("Add photo");
    await type("Taas");
    await userEvent.setup().press(sendButton());
    await act(async () => uploads()[2]?.fail());
    await settle();
    await press("Remove photo");
    await userEvent.setup().press(sendButton());
    await settle();
    expect(fieldsOf(2)[0]).toEqual(["clientId", "22222222-2222-4222-8222-222222222222"]);
    expect(calls.find((c) => c.method === "POST" && c.path.endsWith("/messages"))?.body).toEqual({
      clientId: "33333333-3333-4333-8333-333333333333",
      body: "Taas",
    });
  });

  it("says why no photo was attached: the library not allowed, the check's refusal, a picture the phone could not read; a cancel says nothing", async () => {
    conversation(detail(), [[]]);
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    const PERMISSION =
      "Kuutti could not open your photos. Allow access in the phone's settings and try again.";
    await press("Add photo");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(attached()).toBeNull();
    expect(screen.queryByText(PERMISSION)).toBeNull();
    launch.mockRejectedValueOnce(new Error("Missing permission"));
    await press("Add photo");
    expect(screen.getByText(PERMISSION).props.accessibilityLiveRegion).toBe("assertive");
    (pickPrepared as jest.Mock).mockResolvedValueOnce({ kind: "refused_local" });
    await press("Add photo");
    expect(screen.getByText("This photo cannot be used.")).toBeTruthy();
    expect(screen.queryByText(PERMISSION)).toBeNull();
    (pickPrepared as jest.Mock).mockRejectedValueOnce(new Error("unreadable"));
    await press("Add photo");
    expect(screen.getByText("The photo could not be read. Try another picture.")).toBeTruthy();
    expect(attached()).toBeNull();
    expect(FakeXhr.sent).toEqual([]);
  });

  it("shows a photo three ways: the thumb with its caption and description, Photo removed, and the blurhash until it is read again for its URLs", async () => {
    let reread: (response: Response) => void = () => undefined;
    const calls = api((call) => {
      if (call.method === "GET" && call.path === `/conversations/${ID}`) {
        return json(detail({ counterpartReadUpTo: 3 }));
      }
      if (call.query === "?after=3&limit=1") {
        return new Promise<Response>((resolve) => {
          reread = resolve;
        });
      }
      if (call.method === "GET") {
        return json({
          messages: [
            photoMessage(4, "theirs", null, { urls: null }),
            photoMessage(3, "mine", null, null),
            photoMessage(2, "theirs", "Kesä", null),
            photoMessage(1, "theirs", "Mökillä", { description }),
          ],
        });
      }
      return new Response(null, { status: 204 });
    });
    await renderWithTheme(<ConversationScreen id={ID} />);
    const time = timeOf("en", DAY_2);
    expect(
      await screen.findByRole("button", { name: `Sanna, ${time}, Mökillä. ${WORDS}` }),
    ).toBeTruthy();
    expect(screen.getByText("Mökillä")).toBeTruthy();
    expect(sourceOf(`photo-${idOf(1)}`)).toMatchObject({
      uri: urls(1).thumb,
      cacheKey: `${PHOTO_ID}/thumb`,
    });
    // Gone with its sender: said, with the caption it had, and opening nothing.
    expect(screen.getByLabelText(`Sanna, ${time}, Photo removed. Kesä`)).toBeTruthy();
    expect(screen.getByLabelText(`You, ${time}, Photo removed`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Photo removed/ })).toBeNull();
    // Read under one's own photo as under a text.
    expect(screen.getAllByText("Read")).toHaveLength(1);
    // Without URLs: the blurhash, and the message read again for them.
    const bare = screen.getByTestId(`photo-${idOf(4)}`, { includeHiddenElements: true });
    expect(sourceOf(`photo-${idOf(4)}`)?.uri).toBeUndefined();
    expect(JSON.stringify(bare.props.placeholder)).toContain(BLURHASH);
    expect(screen.getByRole("button", { name: `Sanna, ${time}, Photo` })).toBeTruthy();
    noProblems();
    await act(async () => reread(json({ messages: [photoMessage(4, "theirs", null)] })));
    await waitFor(() => expect(sourceOf(`photo-${idOf(4)}`)?.uri).toBe(urls(4).thumb));
    expect(calls.filter((c) => c.query.includes("limit=1")).map((c) => c.query)).toEqual([
      "?after=3&limit=1",
    ]);
  });

  it("keeps a conversation gone when a photo's read again answers after it went", async () => {
    let gone = false;
    let reread: (response: Response) => void = () => undefined;
    api((call) => {
      if (call.method === "GET" && call.path === `/conversations/${ID}`) {
        return gone ? refusal("not_found", 404) : json(detail());
      }
      if (call.query === "?after=0&limit=1") {
        return new Promise<Response>((resolve) => {
          reread = resolve;
        });
      }
      return json({ messages: [photoMessage(1, "theirs", null, { urls: null })] });
    });
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByRole("button", { name: `Sanna, ${timeOf("en", DAY_2)}, Photo` });
    gone = true;
    await act(async () => focus());
    expect(await screen.findByText("This conversation is no longer available.")).toBeTruthy();
    await act(async () => reread(json({ messages: [photoMessage(1, "theirs", null)] })));
    await settle();
    expect(screen.getByText("This conversation is no longer available.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Photo/ })).toBeNull();
  });

  it("reads a photo again when its URL has expired, once, after a read that failed, and keeps it when the page has it no more", async () => {
    const answers = [
      () => json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500),
      () => json({ messages: [photoMessage(1, "theirs", null, { urls: urls(9) })] }),
    ];
    const calls = api((call) => {
      if (call.method === "GET" && call.path === `/conversations/${ID}`) return json(detail());
      if (call.query === "?after=0&limit=1") return (answers.shift() ?? answers[0])?.() as Response;
      if (call.query === "?after=1&limit=1") return json({ messages: [] });
      if (call.method === "GET") {
        return json({
          messages: [photoMessage(2, "theirs", "Toinen"), photoMessage(1, "theirs", null)],
        });
      }
      return new Response(null, { status: 204 });
    });
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByRole("button", { name: `Sanna, ${timeOf("en", DAY_2)}, Photo` });
    const expire = async (seq: number) => {
      await act(async () => {
        fireEvent(
          screen.getByTestId(`photo-${idOf(seq)}`, { includeHiddenElements: true }),
          "error",
          { nativeEvent: { error: "expired" } },
        );
      });
      await settle();
    };
    await expire(1);
    expect(sourceOf(`photo-${idOf(1)}`)?.uri).toBe(urls(1).thumb);
    await expire(1);
    expect(sourceOf(`photo-${idOf(1)}`)?.uri).toBe(urls(9).thumb);
    await expire(1);
    await expire(2);
    await expire(2);
    expect(sourceOf(`photo-${idOf(2)}`)?.uri).toBe(urls(2).thumb);
    expect(calls.filter((c) => c.query.includes("limit=1")).map((c) => c.query)).toEqual([
      "?after=0&limit=1",
      "?after=0&limit=1",
      "?after=1&limit=1",
    ]);
  });
});
