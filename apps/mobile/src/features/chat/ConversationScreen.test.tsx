import type { ChatMessage, ChatPhoto, ConversationDetail } from "@kuutti/schema";
import { act, fireEvent, screen, userEvent, waitFor } from "@testing-library/react-native";
import * as ImagePicker from "expo-image-picker";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import {
  AccessibilityInfo,
  AppState,
  Clipboard,
  Linking,
  Platform,
  ScrollView,
} from "react-native";
import { pickPrepared } from "@/features/media";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { FAILED_TO_LOAD } from "@/test/failed";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { FakeWebSocket } from "@/test/websocket";
import { FakeXhr, partsOf } from "@/test/xhr";
import { ConversationScreen } from "./ConversationScreen";
import { takeNotice } from "./notice";
import { ChatLiveProvider } from "./store";
import { dayOf, timeOf } from "./time";

// One conversation (#348): the header, the messages by day with who, when and
// what, "Read", the read mark, the composer, Send, the
// optimistic row, the refusals in words with the words kept, the resend with
// the same id, the archived banner, the closed states, earlier messages, and
// the reads on focus; live (#349): what the socket brings, marked read only
// in front, the read mark, Online, the state, the sending row swapped by its
// id, the connection line; a photo (#350): attached, sent with its caption and
// its progress, refused in words, sent again with its id, the picker's
// outcomes, the bubble's three states and the reads again for its URLs;
// contacts (#103): Share contact offered, the dialog's share and stop, its
// refusals and the reads again they ask for, what the other person shares
// under the header, and the reads again on a contacts frame and a resume.

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
  __router: { back: jest.Mock; push: jest.Mock; dismissTo: jest.Mock };
  __focus: () => void;
  __blur: () => void;
};
const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const tokens = {
  sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  accessToken: token("access"),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: `${token("family")}.${token("refresh")}`,
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
  yourTurn: true,
  limits: { maxLength: 30 },
  counterpartReadUpTo: 0,
  contacts: { mine: [], theirs: [] },
  reportable: true,
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
const ATTACHED = "Photo attached.";
const ENDED = "This conversation has ended.";
const LEFT = "This person deleted their account.";
const SUPPORT = "Support when it's hard";
/** The plain-text rule's refusal, with the way through it (#103). */
const CONTACT_DETAILS =
  "A message cannot carry an e-mail address, a link, a phone number or a social media handle. To give your number or a username, keep it in Settings, under Ways to reach you, and share it from the top of the conversation.";
/** The picture above the field: with Remove photo beside it, all that shows a photo is attached (#581). */
const attached = () => screen.queryByTestId("photo-attached", { includeHiddenElements: true });
/** What a screen reader is told with no line drawn, queued behind what is being said on iOS (sayAloud, #581). */
const heard = () =>
  (AccessibilityInfo.announceForAccessibilityWithOptions as jest.Mock).mock.calls.map(
    ([words]) => words,
  );

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
    if (call.method === "GET" && call.path === `/conversations/${ID}/contacts`) {
      return json(shown.contacts);
    }
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
const INSTAGRAM = { kind: "instagram", value: "aino.k", shared: false } as const;
const VILLE_SHARES = { mine: [], theirs: [{ kind: "instagram" as const, value: "ville.k" }] };
const PHONE = { kind: "phone", value: "+358401234567", shared: false } as const;
/** The answers a test may hold back: a read of the detail, of its contacts or of messages, a send, a share. */
type Held = "detail" | "contacts" | "messages" | "send" | "share";
const heldKind = ({ method, path }: Call): Held | null => {
  if (/\/contacts\/\w+$/.test(path)) return "share";
  if (method === "GET" && path === `/conversations/${ID}`) return "detail";
  if (method === "GET" && path === `/conversations/${ID}/contacts`) return "contacts";
  if (path === `/conversations/${ID}/messages`) return method === "GET" ? "messages" : "send";
  return null;
};
/**
 * A conversation whose contacts the share routes change as the API does (a
 * share brings an archived one back), and whose detail the test may change or
 * take away (404); `refusals` answer the next shares or stops instead, an
 * Error failing the request. `pages` are the newest page and the one before
 * it; a send answers its words as message 90. `hold` keeps the next answer of
 * a kind back until the test releases it, and that answer says what was there
 * when it was asked, as a read begun earlier does.
 */
function contactsApi(
  start: ConversationDetail,
  refusals: Array<Response | Error> = [],
  pages: { newest?: ChatMessage[]; before?: ChatMessage[] } = {},
) {
  let shown: ConversationDetail | null = start;
  const gates = new Map<Held, Array<Promise<void>>>();
  const answer = (call: Call): Response => {
    if (call.method === "GET" && call.path === `/conversations/${ID}`) {
      return shown ? json(shown) : refusal("not_found", 404);
    }
    if (call.method === "GET" && call.path === `/conversations/${ID}/contacts`) {
      return shown ? json(shown.contacts) : refusal("not_found", 404);
    }
    if (call.method === "GET" && call.path === `/conversations/${ID}/messages`) {
      return json({
        messages: (call.query.includes("before=") ? pages.before : pages.newest) ?? [],
      });
    }
    if (call.method === "POST" && call.path === `/conversations/${ID}/messages`) {
      const { clientId, body } = call.body as { clientId: string; body: string };
      return json({ ...message(90, "mine", body), clientId });
    }
    const share = /^\/conversations\/[^/]+\/contacts\/(\w+)$/.exec(call.path);
    if (share && shown) {
      const next = refusals.shift();
      if (next instanceof Error) throw next;
      if (next) return next;
      const [, kind] = share;
      const sharing = call.method === "POST";
      shown = {
        ...shown,
        state: sharing && shown.state === "archived" ? "open" : shown.state,
        contacts: {
          ...shown.contacts,
          mine: shown.contacts.mine.map((p) => (p.kind === kind ? { ...p, shared: sharing } : p)),
        },
      };
      return json(shown);
    }
    if (call.path.endsWith("/read")) return new Response(null, { status: 204 });
    return refusal("not_found", 404);
  };
  const calls = api(async (call) => {
    const answered = answer(call);
    const kind = heldKind(call);
    const gate = kind ? gates.get(kind)?.shift() : undefined;
    if (gate) await gate;
    return answered;
  });
  const reads = (path: string) => calls.filter((c) => c.method === "GET" && c.path === path).length;
  return {
    calls,
    detailReads: () => reads(`/conversations/${ID}`),
    contactsReads: () => reads(`/conversations/${ID}/contacts`),
    set: (next: ConversationDetail | null) => {
      shown = next;
    },
    /** Holds the next answer of this kind back; the function returned releases it. */
    hold: (kind: Held) => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      gates.set(kind, [...(gates.get(kind) ?? []), gate]);
      return async () => {
        await act(async () => release());
        await settle();
      };
    },
  };
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
  (AccessibilityInfo.announceForAccessibilityWithOptions as jest.Mock).mockClear();
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
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
    expect(sendButton().props.accessibilityState?.disabled).toBe(true);
    await waitFor(() =>
      expect(calls.filter((c) => c.path.endsWith("/read"))).toEqual([
        { method: "POST", path: `/conversations/${ID}/read`, query: "", body: { upTo: 4 } },
      ]),
    );
    noProblems();
    await press("Back");
    expect(router.back).toHaveBeenCalled();
  });

  it("keeps the newest in sight as the list grows, and once more a frame later, when the new size has reached the screen", async () => {
    conversation(detail(), [[message(1, "theirs", "Moi", DAY_1)]]);
    await renderWithTheme(<ConversationScreen id={ID} />);
    const scroll = await screen.findByTestId("messages");
    // Frames held back until the test runs them, so the two scrolls can be told apart.
    const frames: FrameRequestCallback[] = [];
    jest.spyOn(globalThis, "requestAnimationFrame").mockImplementation((run) => {
      frames.push(run);
      return frames.length;
    });
    const toEnd = jest.spyOn(ScrollView.prototype, "scrollToEnd");
    toEnd.mockClear();
    await act(async () => {
      fireEvent(scroll, "contentSizeChange", 390, 2000);
    });
    expect(toEnd).toHaveBeenCalledTimes(1);
    expect(toEnd).toHaveBeenLastCalledWith({ animated: false });
    for (const run of frames.splice(0)) run(0);
    expect(toEnd).toHaveBeenCalledTimes(2);
    expect(toEnd).toHaveBeenLastCalledWith({ animated: false });
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
      ["Soita 040 123 4567", CONTACT_DETAILS],
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
        return json(
          closed ? detail({ state: "closed", closedHow: "unmatch", counterpart: null }) : detail(),
        );
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
      screen.getByText("This conversation has ended, so the message was not sent.").props
        .accessibilityLiveRegion,
    ).toBe("assertive");
    // The heading says it and the composer goes; a screen reader is told, with no line drawn.
    expectPinnedHeader("Conversation ended", "Back");
    expect(screen.queryByText(ENDED)).toBeNull();
    expect(heard()).toEqual([ENDED]);
    expect(screen.queryByLabelText("Message")).toBeNull();
  });

  it("counts nothing beside Send, and past the longest message says so in a line and stops Send (#581)", async () => {
    const TOO_LONG = "The message is too long. Make it shorter and send it again.";
    const calls = conversation(detail({ limits: { maxLength: 5 } }), [[]]);
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    const off = () => sendButton().props.accessibilityState?.disabled;
    /** What stands in Send's row: Send alone at its end, the line before it past the longest. */
    const row = () => sendButton().parent;
    /** The figures on the screen: the age in the heading, and no count of anything. */
    const figures = () => screen.queryAllByText(/\d/).map((node) => node.props.children);
    expect(off()).toBe(true);
    expect(row()?.children).toHaveLength(1);
    expect(row()?.props.className).toMatch(/\bjustify-end\b/);
    // At the longest, no line and no number: nobody near it is told how near.
    await type("12345");
    expect(off()).toBe(false);
    expect(row()?.children).toHaveLength(1);
    expect(figures()).toEqual(["Sanna, 31"]);
    // One past it.
    await type("123456");
    expect(off()).toBe(true);
    expect(row()?.children).toHaveLength(2);
    // The one word that Send has stopped: said where it appears, on iOS too.
    expect(screen.getByText(TOO_LONG).props.accessibilityLiveRegion).toBe("assertive");
    expect(heard()).toEqual([TOO_LONG]);
    expect(figures()).toEqual(["Sanna, 31"]);
    await userEvent.setup().press(sendButton());
    expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"))).toEqual([]);
    // The spaces around the words are no part of it, and a character is a character.
    await type("  12345  ");
    expect(off()).toBe(false);
    expect(screen.queryByText(TOO_LONG)).toBeNull();
    await type("😀😀😀😀😀");
    expect(off()).toBe(false);
    await type("😀😀😀😀😀😀");
    expect(off()).toBe(true);
    expect(screen.getByText(TOO_LONG)).toBeTruthy();
    // Shortened, the line goes.
    await type("Hei");
    expect(off()).toBe(false);
    expect(screen.queryByText(TOO_LONG)).toBeNull();
    expect(row()?.children).toHaveLength(1);
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
    const line = await screen.findByText("This person deleted their account.");
    expect(line.props.accessibilityLiveRegion).toBe("polite");
    expect(screen.queryByText(ENDED)).toBeNull();
    expectPinnedHeader("Deleted user", "Back");
    expect(said("Deleted user", DAY_1, "Moi")).toBeTruthy();
    expect(screen.queryByLabelText("Message")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add photo" })).toBeNull();
    noProblems();
  });

  it.each<[string, Partial<ConversationDetail>, string, string | null]>([
    // The heading says it, so the link stands alone in the composer's place (#581).
    ["ended", { closedHow: "unmatch", counterpart: null }, "Conversation ended", null],
    [
      "left by a deleted account",
      { closedHow: "erasure", counterpart: { deleted: true } },
      "Deleted user",
      "This person deleted their account.",
    ],
  ])(
    "offers the support page in a conversation %s, however it ended (#510)",
    async (_how, closed, title, line) => {
      conversation(detail({ state: "closed", ...closed }), [[message(1, "theirs", "Moi", DAY_1)]]);
      await renderWithTheme(<ConversationScreen id={ID} />);
      const link = await screen.findByRole("link", { name: SUPPORT });
      expectPinnedHeader(title, "Back");
      expect(screen.queryByText(ENDED)).toBeNull();
      if (line) expect(screen.getByText(line)).toBeTruthy();
      noProblems();
      await act(async () => {
        fireEvent.press(link);
      });
      expect(router.push).toHaveBeenCalledWith("/settings/support");
    },
  );

  it("offers no way to the support page while a conversation goes on (#510)", async () => {
    conversation(detail(), [[message(1, "theirs", "Moi", DAY_1)]]);
    await renderWithTheme(<ConversationScreen id={ID} />);
    expect(await screen.findByLabelText("Message")).toBeTruthy();
    expect(screen.queryByRole("link", { name: SUPPORT })).toBeNull();
  });

  it("heads an ended conversation Conversation ended, names nobody, and offers Report in More while the window holds (#351)", async () => {
    conversation(detail({ state: "closed", closedHow: "unmatch", counterpart: null }), [
      [message(2, "mine", "Kiitos", DAY_1_LATER), message(1, "theirs", "Moi", DAY_1)],
    ]);
    await renderWithTheme(<ConversationScreen id={ID} />);
    expect(await screen.findByRole("heading", { name: "Conversation ended" })).toBeTruthy();
    expectPinnedHeader("Conversation ended", "Back");
    expect(screen.queryByText(ENDED)).toBeNull();
    expect(said("The other person", DAY_1, "Moi")).toBeTruthy();
    expect(said("You", DAY_1_LATER, "Kiitos")).toBeTruthy();
    expect(screen.queryByLabelText("Message")).toBeNull();
    noProblems();
    await press("More");
    expect(screen.getByRole("button", { name: "Report and block" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "End conversation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Block" })).toBeNull();
  });

  it("offers no More in an ended conversation past the window (#351)", async () => {
    conversation(
      detail({ state: "closed", closedHow: "unmatch", counterpart: null, reportable: false }),
      [[message(1, "theirs", "Moi", DAY_1)]],
    );
    await renderWithTheme(<ConversationScreen id={ID} />);
    expect(await screen.findByRole("heading", { name: "Conversation ended" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });

  it("ends the conversation from More and goes back to the list, leaving it the words (#351)", async () => {
    conversation(detail(), [[message(1, "theirs", "Moi", DAY_1)]]);
    const answered = globalThis.fetch;
    const ended: string[] = [];
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === `/conversations/${ID}/unmatch`) {
        ended.push(path);
        return new Response(null, { status: 204 });
      }
      return answered(input, init);
    }) as unknown as typeof fetch;
    router.dismissTo.mockReset();
    await renderWithTheme(<ConversationScreen id={ID} />);
    expect(said("Sanna", DAY_1, "Moi")).toBeTruthy();
    await press("More");
    expect(screen.getByText("Report, block or end")).toBeTruthy();
    await press("End conversation");
    expect(screen.getByText("End this conversation?")).toBeTruthy();
    await press("End conversation");
    expect(ended).toEqual([`/conversations/${ID}/unmatch`]);
    expect(router.dismissTo).toHaveBeenCalledWith("/chats");
    expect(router.back).not.toHaveBeenCalled();
    expect(takeNotice()).toBe("unmatched");
    expect(takeNotice()).toBeNull();
  });

  it("moves nobody when an end lands after the person left the screen, and says it aloud instead (#351)", async () => {
    conversation(detail(), [[message(1, "theirs", "Moi", DAY_1)]]);
    const answered = globalThis.fetch;
    let answer: (response: Response) => void = () => undefined;
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === `/conversations/${ID}/unmatch`) {
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      }
      return answered(input, init);
    }) as unknown as typeof fetch;
    router.dismissTo.mockReset();
    const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
    await renderWithTheme(<ConversationScreen id={ID} />);
    expect(said("Sanna", DAY_1, "Moi")).toBeTruthy();
    await press("More");
    await press("End conversation");
    await press("End conversation");
    // The person goes elsewhere while the answer is on its way.
    await act(async () => blur());
    await act(async () => answer(new Response(null, { status: 204 })));
    await settle();
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(takeNotice()).toBeNull();
    expect(announce).toHaveBeenCalledWith("The conversation has ended.");
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
    expect(await screen.findByText(FAILED_TO_LOAD)).toBeTruthy();
    await press("Try again");
    expect(said("Sanna", DAY_1, "Moi")).toBeTruthy();
  });
});

describe("contacts in a conversation (#103)", () => {
  const BODY =
    "Sanna sees what you share at once. You can stop sharing at any time, but what Sanna already wrote down stays with them.";
  const SHARED = "Shared. Sanna sees it now.";
  const STOPPED = "No longer shared here.";
  const LIMITED = "That was a lot in a short time. Wait a moment and try again.";
  const announced = () =>
    (AccessibilityInfo.announceForAccessibility as jest.Mock).mock.calls.map(([words]) => words);
  /** The labels of everything a finger can press: a value never stands in one. */
  const pressedLabels = () =>
    pressables(screen.toJSON() as HostNode).map((node) => String(node.props.accessibilityLabel));
  const shareOffered = () => screen.queryByRole("button", { name: "Share contact" }) !== null;
  /** The words of a tree, in the order they are read. */
  const wordsIn = (node: HostNode | string): string[] =>
    typeof node === "string" ? [node] : (node.children ?? []).flatMap(wordsIn);
  /** What the dialog draws from its sentence on, so that a line nobody asked for is seen. */
  const fromTheSentence = () => {
    const all = wordsIn(screen.toJSON() as HostNode);
    return all.slice(all.indexOf(BODY));
  };

  beforeEach(() => {
    (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
    (AccessibilityInfo.sendAccessibilityEvent as jest.Mock).mockClear();
  });

  it.each<[string, Partial<ConversationDetail>, boolean]>([
    ["nothing kept, in an open conversation", {}, false],
    [
      "a kept contact, in a conversation that ended",
      { state: "closed", closedHow: "unmatch", contacts: { mine: [INSTAGRAM], theirs: [] } },
      false,
    ],
    [
      "a kept contact, in an open conversation",
      { contacts: { mine: [INSTAGRAM], theirs: [] } },
      true,
    ],
    [
      "a kept contact, in an archived conversation",
      { state: "archived", contacts: { mine: [INSTAGRAM], theirs: [] } },
      true,
    ],
  ])("offers Share contact in the header for %s: %s", async (_what, over, offered) => {
    contactsApi(detail(over));
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByText("Sanna, 31");
    await settle();
    expect(shareOffered()).toBe(offered);
    noProblems();
  });

  it("shares a contact from the dialog in one press, says so, and stops sharing it; a value is shown, never in a label", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const { calls } = contactsApi(detail({ contacts: { mine: [PHONE, INSTAGRAM], theirs: [] } }));
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    await press("Share contact");
    expect(screen.getByText("Share a contact")).toBeTruthy();
    expect(AccessibilityInfo.sendAccessibilityEvent).toHaveBeenCalledWith(
      expect.anything(),
      "focus",
    );
    expect(screen.getByText(BODY)).toBeTruthy();
    expect(screen.getByText("Phone: +358401234567")).toBeTruthy();
    expect(screen.getByText("Instagram: aino.k")).toBeTruthy();
    noProblems();
    await press("Share your Instagram");
    const sharing = () => calls.filter((c) => c.path.includes("/contacts/"));
    expect(sharing()).toEqual([
      { method: "POST", path: `/conversations/${ID}/contacts/instagram`, query: "", body: null },
    ]);
    // The button turns, which is the state in words, with no line under it and none after it (#581).
    expect(screen.getByRole("button", { name: "Stop sharing your Instagram" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share your phone number" })).toBeTruthy();
    expect(fromTheSentence()).toEqual([
      BODY,
      "Phone: +358401234567",
      "Share",
      "Instagram: aino.k",
      "Stop sharing",
    ]);
    expect(pressedLabels().filter((label) => /aino|358/.test(label))).toEqual([]);
    noProblems();
    await press("Stop sharing your Instagram");
    expect(sharing().at(-1)).toEqual({
      method: "DELETE",
      path: `/conversations/${ID}/contacts/instagram`,
      query: "",
      body: null,
    });
    expect(fromTheSentence()).toEqual([
      BODY,
      "Phone: +358401234567",
      "Share",
      "Instagram: aino.k",
      "Share",
    ]);
    expect(screen.getByRole("button", { name: "Share your Instagram" })).toBeTruthy();
    // A screen reader is told, as no line has a live region to speak through.
    expect(announced()).toEqual([SHARED, STOPPED]);
    expect(heard()).toEqual([]);
  });

  it("takes a refusal back at the next press and as the dialog closes", async () => {
    const refused = [refusal("message_budget_exceeded", 429)];
    contactsApi(detail({ contacts: { mine: [INSTAGRAM], theirs: [] } }), refused);
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    await press("Share contact");
    await press("Share your Instagram");
    expect(screen.getByText(LIMITED)).toBeTruthy();
    await press("Share your Instagram");
    expect(screen.queryByText(LIMITED)).toBeNull();
    refused.push(refusal("message_budget_exceeded", 429));
    await press("Stop sharing your Instagram");
    expect(screen.getByText(LIMITED)).toBeTruthy();
    // What was said belongs to that time the dialog was open.
    await press("Close");
    expect(screen.queryByText("Share a contact")).toBeNull();
    await press("Share contact");
    expect(screen.queryByText(LIMITED)).toBeNull();
  });

  it("brings an archived conversation back with a share, as a message does", async () => {
    contactsApi(detail({ state: "archived", contacts: { mine: [INSTAGRAM], theirs: [] } }));
    await renderWithTheme(<ConversationScreen id={ID} />);
    const BANNER = "This conversation was quiet for a week. Write to bring it back.";
    expect(await screen.findByText(BANNER)).toBeTruthy();
    await press("Share contact");
    await press("Share your Instagram");
    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it("tells VoiceOver how a share went, iOS having no live regions", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    contactsApi(detail({ contacts: { mine: [INSTAGRAM], theirs: [] } }), [
      refusal("message_budget_exceeded", 429),
    ]);
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    await press("Share contact");
    await press("Share your Instagram");
    await press("Share your Instagram");
    await press("Stop sharing your Instagram");
    // The refusal is drawn, and told at once; the outcomes are heard alone, queued behind the press.
    expect(announced()).toEqual([LIMITED]);
    expect(heard()).toEqual([SHARED, STOPPED]);
    expect(screen.queryByText(SHARED)).toBeNull();
    expect(screen.queryByText(STOPPED)).toBeNull();
  });

  it("leaves a refusal to its live region on Android, and tells what no line says", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    contactsApi(detail({ contacts: { mine: [INSTAGRAM], theirs: [] } }), [
      refusal("message_budget_exceeded", 429),
    ]);
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    await press("Share contact");
    await press("Share your Instagram");
    expect(screen.getByText(LIMITED).props.accessibilityLiveRegion).toBe("assertive");
    expect(announced()).toEqual([]);
    await press("Share your Instagram");
    expect(announced()).toEqual([SHARED]);
  });

  it.each([
    [
      "fi-FI",
      "Viesti",
      "Jaa yhteystieto",
      "Jaa: Instagram",
      "Lopeta jakaminen: Instagram",
      "Sanna näkee jakamasi heti. Voit lopettaa jakamisen milloin tahansa, mutta minkä Sanna on jo kirjoittanut muistiin, jää hänelle.",
      "Jaettu. Sanna näkee sen nyt.",
      "Ei enää jaettu tässä.",
    ],
    [
      "sv-FI",
      "Meddelande",
      "Dela kontaktuppgift",
      "Dela: Instagram",
      "Sluta dela: Instagram",
      "Sanna ser det du delar direkt. Du kan sluta dela när som helst, men det som Sanna redan har skrivit ner finns kvar.",
      "Delat. Sanna ser det nu.",
      "Delas inte längre här.",
    ],
  ])(
    "says the dialog's sentence in %s, and tells a share and a stop in the same language (#581)",
    async (languageTag, field, open, share, stop, body, shared, stopped) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
      contactsApi(detail({ contacts: { mine: [INSTAGRAM], theirs: [] } }));
      await renderWithTheme(<ConversationScreen id={ID} />);
      await screen.findByLabelText(field);
      await press(open);
      expect(screen.getByText(body)).toBeTruthy();
      await press(share);
      await press(stop);
      expect(heard()).toEqual([shared, stopped]);
    },
  );

  it("says each refusal in the dialog, and reads the conversation again when the refusal says it is out of date", async () => {
    const { calls, detailReads, set } = contactsApi(
      detail({ contacts: { mine: [INSTAGRAM], theirs: [] } }),
      [
        refusal("message_budget_exceeded", 429),
        new TypeError("Network request failed"),
        refusal("validation_failed", 400),
        refusal("contact_not_stored", 409),
      ],
    );
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    await press("Share contact");
    const before = detailReads();
    await press("Share your Instagram");
    expect(
      screen.getByText("That was a lot in a short time. Wait a moment and try again.").props
        .accessibilityLiveRegion,
    ).toBe("assertive");
    // The button is the same one, for the next try.
    expect(screen.getByRole("button", { name: "Share your Instagram" })).toBeTruthy();
    for (let i = 0; i < 2; i += 1) {
      await press("Share your Instagram");
      expect(screen.getByText("That did not go through. Try again.")).toBeTruthy();
    }
    expect(detailReads()).toBe(before);
    // Removed on another phone meanwhile: said, read again, and gone from the dialog and the header.
    set(detail({ contacts: { mine: [], theirs: [] } }));
    await press("Share your Instagram");
    expect(
      screen.getByText("Save this contact under Settings, Ways to reach you, first."),
    ).toBeTruthy();
    expect(detailReads()).toBe(before + 1);
    expect(screen.queryByText("Instagram: aino.k")).toBeNull();
    expect(shareOffered()).toBe(false);
    expect(calls.filter((c) => c.path.includes("/contacts/"))).toHaveLength(4);
  });

  it("says a share refused by an ending, and the ending in the dialog instead of the buttons", async () => {
    const { set } = contactsApi(detail({ contacts: { mine: [INSTAGRAM], theirs: [] } }), [
      refusal("conversation_closed", 409),
    ]);
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    await press("Share contact");
    set(
      detail({
        state: "closed",
        closedHow: "unmatch",
        contacts: { mine: [INSTAGRAM], theirs: [] },
      }),
    );
    await press("Share your Instagram");
    expect(screen.getByText("This conversation has ended, so nothing was shared.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Share your Instagram" })).toBeNull();
    // In the dialog, where the buttons have gone and no heading says why; not instead of the composer.
    expect(screen.getAllByText(ENDED)).toHaveLength(1);
    expect(screen.queryByLabelText("Message")).toBeNull();
    expect(shareOffered()).toBe(false);
    // Told once: the line in the dialog has no live region to speak through.
    expect(heard()).toEqual([ENDED]);
  });

  it("says a conversation gone when a share finds it gone", async () => {
    const { set } = contactsApi(detail({ contacts: { mine: [INSTAGRAM], theirs: [] } }), [
      refusal("not_found", 404),
    ]);
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    await press("Share contact");
    set(null);
    await press("Share your Instagram");
    expect(screen.getByText("This conversation is no longer available.")).toBeTruthy();
    expect(screen.queryByText("Share a contact")).toBeNull();
  });

  it("says nothing of an outcome that came after the dialog closed; opened again, it shows what the press changed", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const { hold } = contactsApi(detail({ contacts: { mine: [INSTAGRAM], theirs: [] } }));
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    await press("Share contact");
    const answer = hold("share");
    await press("Share your Instagram");
    await press("Close");
    await answer();
    expect(announced()).toEqual([]);
    expect(heard()).toEqual([]);
    await press("Share contact");
    expect(screen.getByRole("button", { name: "Stop sharing your Instagram" })).toBeTruthy();
    expect(heard()).toEqual([]);
    // Open, it tells the next one.
    await press("Stop sharing your Instagram");
    expect(heard()).toEqual([STOPPED]);
  });

  it("says nothing of a refusal that came after the dialog closed, and still reads again what it says is out of date", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const { detailReads, hold, set } = contactsApi(
      detail({ contacts: { mine: [INSTAGRAM], theirs: [] } }),
      [refusal("contact_not_stored", 409)],
    );
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    await press("Share contact");
    const answer = hold("share");
    await press("Share your Instagram");
    await press("Close");
    set(detail({ contacts: { mine: [], theirs: [] } }));
    const before = detailReads();
    await answer();
    expect(announced()).toEqual([]);
    expect(
      screen.queryByText("Save this contact under Settings, Ways to reach you, first."),
    ).toBeNull();
    expect(detailReads()).toBe(before + 1);
    expect(shareOffered()).toBe(false);
  });

  it.each([
    [
      "en-US",
      "Sanna shares Instagram: ville.k",
      "Sanna shares a phone number: +358401234568",
      "Phone: +358401234568",
    ],
    [
      "fi-FI",
      "Sanna jakaa yhteystiedon. Instagram: ville.k",
      "Sanna jakaa yhteystiedon. Puhelin: +358401234568",
      "Puhelin: +358401234568",
    ],
    [
      "sv-FI",
      "Sanna delar en kontaktuppgift. Instagram: ville.k",
      "Sanna delar en kontaktuppgift. Telefon: +358401234568",
      "Telefon: +358401234568",
    ],
  ])(
    "shows what the other person shares under the header, as text to select, heard as who shares what (%s)",
    async (language, instagram, phone, phoneLine) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: language }]);
      contactsApi(
        detail({
          contacts: {
            mine: [],
            theirs: [
              { kind: "instagram", value: "ville.k" },
              { kind: "phone", value: "+358401234568" },
            ],
          },
        }),
      );
      await renderWithTheme(<ConversationScreen id={ID} />);
      const line = await screen.findByText("Instagram: ville.k");
      expect(line.props.selectable).toBe(true);
      expect(line.props.accessibilityLabel).toBe(instagram);
      expect(screen.getByText(phoneLine).props.accessibilityLabel).toBe(phone);
      // The buttons beside them name no value.
      expect(pressedLabels().filter((label) => /ville|358/.test(label))).toEqual([]);
      noProblems();
      // What was there when the screen opened is not announced.
      expect(announced()).toEqual([]);
    },
  );

  it("Opening or copying a contact tells nobody", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    const copied = jest.spyOn(Clipboard, "setString").mockImplementation(() => undefined);
    const { calls } = contactsApi(
      detail({ contacts: { mine: [], theirs: [{ kind: "instagram", value: "ville.k" }] } }),
    );
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByText("Instagram: ville.k");
    await settle();
    const before = calls.length;
    await fireEvent.press(screen.getByRole("link", { name: "Open Instagram: Sanna" }));
    await fireEvent.press(screen.getByRole("button", { name: "Copy Instagram: Sanna" }));
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    expect(copied).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(before);
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
    expectPinnedHeader("Conversation ended", "Back");
    expect(screen.queryByText(ENDED)).toBeNull();
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

  it("reads the contacts alone again when the socket says they changed here, and after a resume, and shows none once it closes the conversation (#103)", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
    const { calls, contactsReads, detailReads, set } = contactsApi(detail());
    await renderWithTheme(
      <ChatLiveProvider>
        <ConversationScreen id={ID} />
      </ChatLiveProvider>,
    );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await screen.findByLabelText("Message");
    await ready();
    await settle();
    const pages = () => calls.filter((c) => c.path.endsWith("/messages")).length;
    const [reads, details, paged] = [contactsReads(), detailReads(), pages()];
    set(detail({ contacts: VILLE_SHARES }));
    // Another conversation's contacts: nothing to read here.
    await frame({ type: "contacts", conversationId: "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a71" });
    await settle();
    expect(contactsReads()).toBe(reads);
    await frame({ type: "contacts", conversationId: ID });
    await settle();
    expect(contactsReads()).toBe(reads + 1);
    expect(pages()).toBe(paged);
    expect(screen.getByLabelText("Sanna shares Instagram: ville.k")).toBeTruthy();
    const shares = () => announced().filter((words: string) => words.startsWith("Sanna shares"));
    expect(shares()).toEqual(["Sanna shares Instagram: ville.k"]);
    // Taken back while the socket was away: the resume reads it again.
    set(detail());
    jest.useFakeTimers();
    await act(async () => FakeWebSocket.latest().drop());
    await act(() => jest.advanceTimersByTimeAsync(1000));
    await ready();
    jest.useRealTimers();
    await settle();
    expect(contactsReads()).toBe(reads + 2);
    expect(screen.queryByText("Instagram: ville.k")).toBeNull();
    // Shared again, then the conversation closes: no contacts frame follows a close.
    set(detail({ contacts: VILLE_SHARES }));
    await frame({ type: "contacts", conversationId: ID });
    await settle();
    expect(screen.getByText("Instagram: ville.k")).toBeTruthy();
    await frame({
      type: "conversation",
      conversationId: ID,
      state: "closed",
      closedHow: "unmatch",
    });
    expect(screen.queryByText("Instagram: ville.k")).toBeNull();
    expect(shares()).toEqual([
      "Sanna shares Instagram: ville.k",
      "Sanna shares Instagram: ville.k",
    ]);
    // The detail itself was read again only for the close, so the ended view names
    // nobody (#351): the contacts frames read the contacts alone, which sign no thumb.
    await settle();
    expect(detailReads()).toBe(details + 1);
    expect(screen.queryByText("Instagram: ville.k")).toBeNull();
  });

  it("keeps what is shown when a read for the contacts fails, and says a conversation gone when it finds one (#103)", async () => {
    const { contactsReads, set } = contactsApi(detail());
    await renderWithTheme(
      <ChatLiveProvider>
        <ConversationScreen id={ID} />
      </ChatLiveProvider>,
    );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await screen.findByLabelText("Message");
    await ready();
    await settle();
    const reads = contactsReads();
    const failing = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => {
      throw new TypeError("Network request failed");
    }) as unknown as typeof fetch;
    await frame({ type: "contacts", conversationId: ID });
    await settle();
    expect(screen.getByLabelText("Message")).toBeTruthy();
    globalThis.fetch = failing;
    set(null);
    await frame({ type: "contacts", conversationId: ID });
    await settle();
    expect(contactsReads()).toBe(reads + 1);
    expect(screen.getByText("This conversation is no longer available.")).toBeTruthy();
  });

  it("leaves a conversation that never loaded to Try again when the contacts change, which then shows them (#103)", async () => {
    let fails = true;
    const { contactsReads, detailReads } = contactsApi(detail({ contacts: VILLE_SHARES }), [], {
      newest: [message(1, "theirs", "Moi", DAY_1)],
    });
    const answering = globalThis.fetch;
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      if (fails) throw new TypeError("Network request failed");
      return answering(input, init);
    }) as unknown as typeof fetch;
    await renderWithTheme(
      <ChatLiveProvider>
        <ConversationScreen id={ID} />
      </ChatLiveProvider>,
    );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(await screen.findByText(FAILED_TO_LOAD)).toBeTruthy();
    fails = false;
    await ready();
    await frame({ type: "contacts", conversationId: ID });
    await settle();
    expect([contactsReads(), detailReads()]).toEqual([2, 0]);
    // Read, but not shown over the failure: the messages were never read.
    expect(screen.getByText(FAILED_TO_LOAD)).toBeTruthy();
    expect(screen.queryByText("Instagram: ville.k")).toBeNull();
    await press("Try again");
    expect(said("Sanna", DAY_1, "Moi")).toBeTruthy();
    expect(screen.getByText("Instagram: ville.k")).toBeTruthy();
  });

  it("takes the share dialog's buttons and the header's offer away when the socket closes the conversation (#103)", async () => {
    contactsApi(detail({ contacts: { mine: [{ ...INSTAGRAM, shared: true }], theirs: [] } }));
    await renderWithTheme(
      <ChatLiveProvider>
        <ConversationScreen id={ID} />
      </ChatLiveProvider>,
    );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await screen.findByLabelText("Message");
    await ready();
    await settle();
    await press("Share contact");
    expect(screen.getByRole("button", { name: "Stop sharing your Instagram" })).toBeTruthy();
    await frame({
      type: "conversation",
      conversationId: ID,
      state: "closed",
      closedHow: "unmatch",
    });
    expect(screen.queryByRole("button", { name: "Share contact" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop sharing your Instagram" })).toBeNull();
    // In the dialog alone: behind it the heading says it.
    expect(screen.getAllByText(ENDED)).toHaveLength(1);
    expect(heard()).toEqual([ENDED]);
  });

  describe("an end while on the screen (#581)", () => {
    const CLOSED = {
      type: "conversation",
      conversationId: ID,
      state: "closed",
      closedHow: "unmatch",
    };
    const REPORT = "Report and block";
    const onTheScreen = async (shown: ConversationDetail = detail()) => {
      await live(shown, [[message(1, "theirs", "Moi", DAY_1)]]);
      await screen.findByLabelText("Message");
      await ready();
    };

    it.each<[string, "ios" | "android", Partial<ConversationDetail>, string[], string[]]>([
      ["iOS, queued", "ios", {}, [ENDED], []],
      ["Android, with the plain call", "android", {}, [], [ENDED]],
      ["iOS, from an archived conversation", "ios", { state: "archived" }, [ENDED], []],
    ])(
      "is told once to a screen reader on %s, with no line drawn, the heading saying it",
      async (_where, os, over, queued, plain) => {
        jest.replaceProperty(Platform, "OS", os);
        await onTheScreen(detail(over));
        await frame(CLOSED);
        await settle();
        expectPinnedHeader("Conversation ended", "Back");
        expect(screen.queryByText(ENDED)).toBeNull();
        expect(screen.queryByLabelText("Message")).toBeNull();
        expect(screen.getByRole("link", { name: SUPPORT })).toBeTruthy();
        noProblems();
        expect(heard()).toEqual(queued);
        expect(announced()).toEqual(plain);
        // Not again on a look back, on a new frame, or on what the read after it brings.
        await act(async () => focus());
        await settle();
        await frame(CLOSED);
        await settle();
        expect(heard()).toEqual(queued);
        expect(announced()).toEqual(plain);
      },
    );

    it.each([
      ["fi-FI", "Viesti", "Keskustelu päättynyt", "Takaisin", "Tämä keskustelu on päättynyt."],
      [
        "sv-FI",
        "Meddelande",
        "Samtalet har avslutats",
        "Tillbaka",
        "Det här samtalet har avslutats.",
      ],
    ])(
      "is told in %s, its heading drawn in the same language",
      async (languageTag, field, title, back, words) => {
        (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
        await live(detail(), [[message(1, "theirs", "Moi", DAY_1)]]);
        await screen.findByLabelText(field);
        await ready();
        await frame(CLOSED);
        await settle();
        expectPinnedHeader(title, back);
        expect(heard()).toEqual([words]);
        expect(screen.queryByText(words)).toBeNull();
      },
    );

    it("is told when a read finds it, the screen in front", async () => {
      const { set } = contactsApi(detail());
      await renderWithTheme(<ConversationScreen id={ID} />);
      await screen.findByLabelText("Message");
      expect(heard()).toEqual([]);
      set(detail({ state: "closed", closedHow: "unmatch", counterpart: null }));
      await act(async () => focus());
      await settle();
      expectPinnedHeader("Conversation ended", "Back");
      expect(heard()).toEqual([ENDED]);
    });

    it.each<[string, Partial<ConversationDetail>]>([
      ["ended", { state: "closed", closedHow: "unmatch", counterpart: null }],
      [
        "left by a deleted account",
        { state: "closed", closedHow: "erasure", counterpart: { deleted: true } },
      ],
    ])("is told nothing on opening a conversation already %s", async (_how, over) => {
      await live(detail(over), [[message(1, "theirs", "Moi", DAY_1)]]);
      await screen.findByRole("link", { name: SUPPORT });
      await ready();
      await act(async () => focus());
      await settle();
      expect(heard()).toEqual([]);
      expect(announced()).toEqual([]);
    });

    it("waits behind the dialog of More, and is told once as it closes", async () => {
      await onTheScreen();
      await press("More");
      await frame(CLOSED);
      await settle();
      expect(heard()).toEqual([]);
      await press("Cancel");
      await settle();
      expect(heard()).toEqual([ENDED]);
      expectPinnedHeader("Conversation ended", "Back");
      expect(screen.getByRole("button", { name: "More" })).toBeTruthy();
      await press("More");
      expect(screen.getByRole("button", { name: REPORT })).toBeTruthy();
      expect(heard()).toEqual([ENDED]);
    });

    it("waits while another screen is over it, and is told once on coming back", async () => {
      await onTheScreen();
      await act(async () => blur());
      await frame(CLOSED);
      await settle();
      expect(heard()).toEqual([]);
      await act(async () => focus());
      await settle();
      expect(heard()).toEqual([ENDED]);
      expectPinnedHeader("Conversation ended", "Back");
    });

    it("is told nothing of another conversation's end, or of a conversation gone, whose line speaks for itself", async () => {
      await onTheScreen();
      await frame({ ...CLOSED, conversationId: "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a71" });
      await settle();
      expect(screen.getByLabelText("Message")).toBeTruthy();
      expect(heard()).toEqual([]);
      await frame({ type: "conversation", conversationId: ID, state: "gone", closedHow: null });
      expect(screen.getByText("This conversation is no longer available.")).toBeTruthy();
      expect(heard()).toEqual([]);
    });

    it("names nobody from the frame on, even if the read after it fails", async () => {
      await onTheScreen();
      globalThis.fetch = jest.fn(async () => {
        throw new TypeError("Network request failed");
      }) as unknown as typeof fetch;
      await frame(CLOSED);
      await settle();
      expectPinnedHeader("Conversation ended", "Back");
      expect(said("The other person", DAY_1, "Moi")).toBeTruthy();
      expect(screen.queryByText(/Sanna/)).toBeNull();
      expect(screen.getByRole("link", { name: SUPPORT })).toBeTruthy();
    });

    it("is told nothing of an end the person brought about behind the dialog: the list says it", async () => {
      await onTheScreen();
      const answered = globalThis.fetch;
      globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return new URL(request.url).pathname === `/conversations/${ID}/unmatch`
          ? new Response(null, { status: 204 })
          : answered(input, init);
      }) as unknown as typeof fetch;
      await press("More");
      await press("End conversation");
      // Its own frame may come before the answer.
      await frame(CLOSED);
      await settle();
      await press("End conversation");
      await settle();
      expect(takeNotice()).toBe("unmatched");
      expect(heard()).toEqual([]);
    });

    it("leaves an erasure's line to its live region on Android", async () => {
      jest.replaceProperty(Platform, "OS", "android");
      await onTheScreen();
      await frame({ ...CLOSED, closedHow: "erasure" });
      await settle();
      expect(screen.getByText(LEFT).props.accessibilityLiveRegion).toBe("polite");
      expect(heard()).toEqual([]);
      expect(announced()).toEqual([]);
    });

    it("keeps the name when the socket says the person left, until a read says Deleted user, their leaving drawn in a live region and said once on iOS, which has none", async () => {
      const { set } = contactsApi(detail(), [], { newest: [message(1, "theirs", "Moi", DAY_1)] });
      await renderWithTheme(
        <ChatLiveProvider>
          <ConversationScreen id={ID} />
        </ChatLiveProvider>,
      );
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      await screen.findByLabelText("Message");
      await ready();
      await settle();
      const answering = globalThis.fetch;
      globalThis.fetch = jest.fn(async () => {
        throw new TypeError("Network request failed");
      }) as unknown as typeof fetch;
      await frame({ ...CLOSED, closedHow: "erasure" });
      await settle();
      expectPinnedHeader("Sanna, 31", "Back");
      const line = screen.getByText(LEFT);
      expect(line.props.accessibilityLiveRegion).toBe("polite");
      expect(screen.queryByLabelText("Message")).toBeNull();
      expect(heard()).toEqual([LEFT]);
      globalThis.fetch = answering;
      set(detail({ state: "closed", closedHow: "erasure", counterpart: { deleted: true } }));
      await act(async () => focus());
      await settle();
      expectPinnedHeader("Deleted user", "Back");
      expect(heard()).toEqual([LEFT]);
    });
  });

  describe("the contacts read alone, and the newest detail kept (#103)", () => {
    const BANNER = "This conversation was quiet for a week. Write to bring it back.";
    const contactsFrame = () => frame({ type: "contacts", conversationId: ID });
    /** The screen under the live provider, loaded, its socket open and its resume's read done. */
    async function openLive(): Promise<void> {
      await renderWithTheme(
        <ChatLiveProvider>
          <ConversationScreen id={ID} />
        </ChatLiveProvider>,
      );
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      await screen.findByLabelText("Message");
      await ready();
      await settle();
    }

    it("reads them once for a burst of frames and once more after it, and merges them into the detail shown, keeping the rest of it", async () => {
      const { contactsReads, detailReads, hold, set } = contactsApi(
        detail({ state: "archived" }),
        [],
        { newest: [message(1, "theirs", "Moi", DAY_1)] },
      );
      await openLive();
      const [reads, details] = [contactsReads(), detailReads()];
      // What a read of the whole detail would bring now; only its contacts are read.
      set(
        detail({
          state: "open",
          counterpart: { deleted: false, name: "Ville", age: 40, thumb: null },
          contacts: VILLE_SHARES,
        }),
      );
      const release = hold("contacts");
      for (let i = 0; i < 5; i += 1) await contactsFrame();
      await settle();
      expect(contactsReads()).toBe(reads + 1);
      await release();
      expect(contactsReads()).toBe(reads + 2);
      expect(detailReads()).toBe(details);
      expect(screen.getByLabelText("Sanna shares Instagram: ville.k")).toBeTruthy();
      expect(screen.getByText("Sanna, 31")).toBeTruthy();
      expect(screen.getByText(BANNER)).toBeTruthy();
      expect(said("Sanna", DAY_1, "Moi")).toBeTruthy();
      // Done: the next frame reads again.
      await contactsFrame();
      await settle();
      expect(contactsReads()).toBe(reads + 3);
    });

    it.each(["words", "a photo"])(
      "keeps what a read brought while a send of %s was on its way, and the conversation the send brought back",
      async (what) => {
        const { hold, set } = contactsApi(detail({ state: "archived" }));
        await openLive();
        const sent = what === "words" ? hold("send") : null;
        if (sent) await type("Hei");
        else {
          picks();
          await press("Add photo");
        }
        await userEvent.setup().press(sendButton());
        set(detail({ contacts: VILLE_SHARES }));
        await contactsFrame();
        await settle();
        expect(screen.getByText("Instagram: ville.k")).toBeTruthy();
        if (sent) await sent();
        else {
          await act(async () =>
            uploads()[0]?.answer(201, {
              ...photoMessage(90, "mine", null),
              clientId: "11111111-1111-4111-8111-111111111111",
            }),
          );
          await settle();
        }
        expect(screen.queryByText(/^Sending/)).toBeNull();
        expect(screen.getByText("Instagram: ville.k")).toBeTruthy();
        expect(screen.queryByText(BANNER)).toBeNull();
      },
    );

    it("keeps what a read brought while a page of earlier messages was on its way", async () => {
      const full = Array.from({ length: 50 }, (_, i) =>
        message(51 - i, "theirs", `Viesti ${51 - i}`),
      );
      const { hold, set } = contactsApi(detail(), [], {
        newest: full,
        before: [message(1, "theirs", "Yksi")],
      });
      await openLive();
      const page = hold("messages");
      await press("Earlier messages");
      set(detail({ contacts: VILLE_SHARES }));
      await contactsFrame();
      await settle();
      expect(screen.getByText("Instagram: ville.k")).toBeTruthy();
      await page();
      expect(said("Sanna", DAY_2, "Yksi")).toBeTruthy();
      expect(screen.getByText("Instagram: ville.k")).toBeTruthy();
    });

    it("keeps the conversation a send brought back when a reload begun before the send answers after it", async () => {
      const { hold } = contactsApi(detail({ state: "archived" }));
      await openLive();
      const reload = hold("detail");
      await act(async () => focus());
      await settle();
      await type("Hei");
      await userEvent.setup().press(sendButton());
      await settle();
      expect(said("You", DAY_2, "Hei")).toBeTruthy();
      expect(screen.queryByText(BANNER)).toBeNull();
      await reload();
      expect(screen.queryByText(BANNER)).toBeNull();
    });

    it("shows what the resume read while the first page was on its way, not the older detail read before it", async () => {
      const { hold, set } = contactsApi(detail());
      const page = hold("messages");
      await renderWithTheme(
        <ChatLiveProvider>
          <ConversationScreen id={ID} />
        </ChatLiveProvider>,
      );
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      await settle();
      set(detail({ contacts: VILLE_SHARES }));
      await ready();
      await settle();
      expect(screen.getByText("Loading…")).toBeTruthy();
      await page();
      expect(screen.getByLabelText("Message")).toBeTruthy();
      expect(screen.getByText("Instagram: ville.k")).toBeTruthy();
    });

    it.each<[string, "detail" | "messages"]>([
      ["its detail", "detail"],
      ["its page", "messages"],
    ])(
      "keeps what a read brought while a reload on focus waited for %s, the reload's detail being older",
      async (_what, held) => {
        const { hold, set } = contactsApi(detail());
        await openLive();
        const page = hold(held);
        await act(async () => focus());
        await settle();
        set(detail({ contacts: VILLE_SHARES }));
        await contactsFrame();
        await settle();
        expect(screen.getByText("Instagram: ville.k")).toBeTruthy();
        await page();
        expect(screen.getByText("Instagram: ville.k")).toBeTruthy();
      },
    );

    it("never lets a read begun earlier take the place of a reload's detail or a share's answer that came first", async () => {
      const { hold, set } = contactsApi(
        detail({ contacts: { mine: [INSTAGRAM], theirs: VILLE_SHARES.theirs } }),
      );
      await openLive();
      expect(screen.getByText("Instagram: ville.k")).toBeTruthy();
      // Begun while Sanna still shared it; she stops, and a reload on focus says so first.
      const older = hold("contacts");
      await contactsFrame();
      await settle();
      set(detail({ contacts: { mine: [INSTAGRAM], theirs: [] } }));
      await act(async () => focus());
      await settle();
      expect(screen.queryByText("Instagram: ville.k")).toBeNull();
      await older();
      expect(screen.queryByText("Instagram: ville.k")).toBeNull();
      // Begun before the person shared: the share's answer is newer. The read that answer asks
      // for waits too, or it would land behind the older one and put right what that took away.
      const before = hold("contacts");
      const after = hold("contacts");
      await contactsFrame();
      await settle();
      await press("Share contact");
      await press("Share your Instagram");
      const stop = () => screen.getByRole("button", { name: "Stop sharing your Instagram" });
      expect(stop()).toBeTruthy();
      await before();
      expect(stop()).toBeTruthy();
      await after();
      expect(stop()).toBeTruthy();
    });

    it.each<["share" | "stop", "the answer" | "her frame's read"]>([
      ["share", "the answer"],
      ["share", "her frame's read"],
      ["stop", "the answer"],
      ["stop", "her frame's read"],
    ])(
      "shows what Sanna shared at the same moment as the person's %s, %s landing first",
      async (what, first) => {
        const wasShared = what === "stop";
        const { contactsReads, hold, set } = contactsApi(
          detail({ contacts: { mine: [{ ...INSTAGRAM, shared: wasShared }], theirs: [] } }),
        );
        await openLive();
        const reads = contactsReads();
        await press("Share contact");
        // The API reads the person's fresh view before Sanna's share commits...
        const answer = hold("share");
        await press(wasShared ? "Stop sharing your Instagram" : "Share your Instagram");
        set(
          detail({
            contacts: { mine: [{ ...INSTAGRAM, shared: !wasShared }], theirs: VILLE_SHARES.theirs },
          }),
        );
        // ...and her commit's frame begins a read before that answer arrives.
        const read = hold("contacts");
        await contactsFrame();
        await settle();
        expect(contactsReads()).toBe(reads + 1);
        if (first === "the answer") {
          await answer();
          await read();
        } else {
          await read();
          await answer();
        }
        // The answer is newer than the read begun before it, its contacts no
        // fresher: a read after it brings hers.
        expect(contactsReads()).toBe(reads + 2);
        expect(screen.getByText("Instagram: ville.k")).toBeTruthy();
        expect(heard()).toEqual([
          what === "share" ? "Shared. Sanna sees it now." : "No longer shared here.",
        ]);
        expect(
          screen.getByRole("button", {
            name: wasShared ? "Share your Instagram" : "Stop sharing your Instagram",
          }),
        ).toBeTruthy();
      },
    );
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
    // The picture and Remove photo show it; a screen reader is told, with no line drawn (#581).
    expect(attached()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove photo" })).toBeTruthy();
    expect(screen.queryByText(ATTACHED)).toBeNull();
    expect(heard()).toEqual([ATTACHED]);
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
      ["contact_details", 400, CONTACT_DETAILS, true],
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
    // Put back, not picked: the failure's line says what happened, and nothing more is told.
    expect(heard()).toEqual([ATTACHED]);
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
    // Nothing attached, nothing told.
    expect(heard()).toEqual([]);
  });

  it.each<["ios" | "android", string[], string[]]>([
    ["ios", [ATTACHED], []],
    ["android", [], [ATTACHED]],
  ])(
    "tells a screen reader on %s that a photo was picked, once, and nothing as it is taken off (#581)",
    async (os, queued, plain) => {
      jest.replaceProperty(Platform, "OS", os);
      conversation(detail(), [[]]);
      await renderWithTheme(<ConversationScreen id={ID} />);
      await screen.findByLabelText("Message");
      picks();
      await press("Add photo");
      const announced = (AccessibilityInfo.announceForAccessibility as jest.Mock).mock.calls;
      expect(heard()).toEqual(queued);
      expect(announced.map(([words]) => words)).toEqual(plain);
      await press("Remove photo");
      expect(heard()).toEqual(queued);
      expect(announced.map(([words]) => words)).toEqual(plain);
    },
  );

  it.each([
    ["fi-FI", "Viesti", "Lisää kuva", "Kuva liitetty."],
    ["sv-FI", "Meddelande", "Lägg till foto", "Foto bifogat."],
  ])("tells a picked photo in %s (#581)", async (languageTag, field, add, words) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
    conversation(detail(), [[]]);
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText(field);
    picks();
    await press(add);
    expect(heard()).toEqual([words]);
    expect(screen.queryByText(words)).toBeNull();
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

  it.each([
    ["going on", detail(), "open"],
    ["archived", detail({ state: "archived" }), "open"],
    [
      "ended within the window",
      detail({ state: "closed", closedHow: "unmatch", counterpart: null }),
      "ended",
    ],
    [
      "ended past the window",
      detail({ state: "closed", closedHow: "unmatch", counterpart: null, reportable: false }),
      null,
    ],
  ] as const)(
    "tells the other person's photo full size whether a conversation %s takes a report, and one's own photo nothing (#476)",
    async (_, shown, report) => {
      conversation(shown, [
        [photoMessage(2, "mine", "Minun"), photoMessage(1, "theirs", "Mökillä", {}, DAY_1)],
      ]);
      await renderWithTheme(<ConversationScreen id={ID} />);
      /** The params of the link a press on the photo of this caption opens. */
      const link = async (caption: RegExp) => {
        router.push.mockReset();
        await userEvent.setup().press(await screen.findByRole("button", { name: caption }));
        await settle();
        expect(router.push).toHaveBeenCalledTimes(1);
        const [[pushed]] = router.push.mock.calls as [[{ params: Record<string, string> }]];
        return pushed.params;
      };
      const theirs = await link(/, Mökillä$/);
      expect(theirs).toEqual({
        messageId: idOf(1),
        conversation: ID,
        seq: "1",
        blurhash: BLURHASH,
        ...(report ? { report } : {}),
      });
      // A link's params are strings: a missing one is left out, never undefined.
      expect(Object.keys(theirs).includes("report")).toBe(report !== null);
      // One's own photo is no report's, whatever the conversation takes.
      const mine = await link(/^You, .+, Minun$/);
      expect(Object.keys(mine)).toEqual(["messageId", "conversation", "seq", "blurhash"]);
    },
  );
});

describe("a conversation's More (#351)", () => {
  const CHOICES = ["Block", "Report and block", "End conversation"];
  const GONE = "This conversation is no longer available.";
  const NOTE = "Anything the moderators should know (optional, up to 500 characters)";
  const ACT = /\/(report|block|unmatch)$/;
  const done = () => new Response(null, { status: 204 });

  /** The conversation as the API answers it, the detail the test may change, and its acts answered as told. */
  function moreApi(
    start: ConversationDetail,
    answer: (call: Call) => Response | Promise<Response> = done,
  ) {
    let shown = start;
    const calls = api((call) => {
      if (call.method === "GET" && call.path === `/conversations/${ID}`) return json(shown);
      if (call.method === "GET" && call.path === `/conversations/${ID}/contacts`) {
        return json(shown.contacts);
      }
      if (call.method === "GET") return json({ messages: [message(1, "theirs", "Moi", DAY_1)] });
      if (ACT.test(call.path)) return answer(call);
      return done();
    });
    return {
      acts: () => calls.filter((c) => ACT.test(c.path)).map(({ path, body }) => ({ path, body })),
      detailReads: () =>
        calls.filter((c) => c.method === "GET" && c.path === `/conversations/${ID}`).length,
      set: (next: ConversationDetail) => {
        shown = next;
      },
    };
  }
  /** What the dialog behind More offers, each a named button. */
  const offered = () => CHOICES.filter((name) => screen.queryByRole("button", { name }) !== null);
  const radio = async (name: string) => {
    await userEvent.setup().press(screen.getByRole("radio", { name }));
    await settle();
  };
  const frame = (sent: unknown) => act(async () => FakeWebSocket.latest().receive(sent));
  /** The screen under the live provider, its socket open, the conversation shown. */
  async function live(): Promise<void> {
    FakeWebSocket.install();
    await renderWithTheme(
      <ChatLiveProvider>
        <ConversationScreen id={ID} />
      </ChatLiveProvider>,
    );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await screen.findByLabelText("Message");
    await act(async () => {
      FakeWebSocket.latest().open();
      FakeWebSocket.latest().receive({ type: "ready" });
    });
  }

  beforeEach(() => {
    router.dismissTo.mockReset();
    takeNotice();
  });

  it.each([
    ["an open conversation", detail(), CHOICES],
    ["an archived one", detail({ state: "archived" }), CHOICES],
    [
      "an ended one, while it can be reported",
      detail({ state: "closed", closedHow: "unmatch", counterpart: null }),
      ["Report and block"],
    ],
  ])("offers under More what %s allows", async (_, shown, choices) => {
    moreApi(shown);
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByRole("button", { name: "More" });
    noProblems();
    await press("More");
    expect(screen.getByText("Report, block or end")).toBeTruthy();
    expect(offered()).toEqual(choices);
    noProblems();
    await press("Cancel");
    expect(offered()).toEqual([]);
  });

  it("sits after Share contact in the header, the order a screen reader reaches them, and only there", async () => {
    moreApi(detail({ contacts: { mine: [INSTAGRAM], theirs: [] } }));
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    const labels = pressables(screen.toJSON() as HostNode).map(
      (node) => node.props.accessibilityLabel,
    );
    expect(labels.slice(0, 3)).toEqual(["Back", "Share contact", "More"]);
    expect(labels.filter((label) => label === "More")).toHaveLength(1);
  });

  it("reports from the conversation with the reason and the note, and goes back to the list, leaving it the thanks", async () => {
    const { acts } = moreApi(detail());
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    await press("More");
    await press("Report and block");
    await radio("Harassing, threatening or hateful");
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText(NOTE), "Threatened me after I said no.");
    });
    await press("Send report");
    expect(acts()).toEqual([
      {
        path: `/conversations/${ID}/report`,
        body: { reason: "harassment", note: "Threatened me after I said no." },
      },
    ]);
    expect(router.dismissTo).toHaveBeenCalledWith("/chats");
    expect(router.back).not.toHaveBeenCalled();
    expect(takeNotice()).toBe("reported");
  });

  it("blocks from the conversation after its confirmation, and goes back to the list, leaving it the word", async () => {
    const { acts } = moreApi(detail({ state: "archived" }));
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByLabelText("Message");
    await press("More");
    await press("Block");
    expect(screen.getByText("Block this person?")).toBeTruthy();
    expect(acts()).toEqual([]);
    await press("Block");
    expect(acts()).toEqual([{ path: `/conversations/${ID}/block`, body: null }]);
    expect(router.dismissTo).toHaveBeenCalledWith("/chats");
    expect(router.back).not.toHaveBeenCalled();
    expect(takeNotice()).toBe("blocked");
  });

  it.each([
    ["a report", "reported" as const],
    ["a block", "blocked" as const],
  ])(
    "keeps the dialog through the frame that takes the conversation away before the answer to %s, then goes back to the list",
    async (_, outcome) => {
      let land: (response: Response) => void = () => undefined;
      moreApi(detail(), () => new Promise<Response>((resolve) => (land = resolve)));
      await live();
      await press("More");
      if (outcome === "reported") {
        await press("Report and block");
        await radio("Something else");
        await press("Send report");
      } else {
        await press("Block");
        await press("Block");
      }
      expect(screen.getByText("Sending…")).toBeTruthy();
      // The block it sets reaches the person's own socket before the answer does.
      await frame({ type: "conversation", conversationId: ID, state: "gone", closedHow: null });
      expect(screen.getByText(GONE)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "More" })).toBeNull();
      expect(screen.getByText("Sending…")).toBeTruthy();
      expect(router.dismissTo).not.toHaveBeenCalled();
      await act(async () => land(done()));
      await settle();
      expect(router.dismissTo).toHaveBeenCalledWith("/chats");
      expect(router.back).not.toHaveBeenCalled();
      expect(takeNotice()).toBe(outcome);
    },
  );

  it.each([
    ["a report", "reported" as const],
    ["a block", "blocked" as const],
  ])(
    "says nothing on Android of the frame that takes the conversation away before the answer to %s",
    async (_, outcome) => {
      jest.replaceProperty(Platform, "OS", "android");
      let land: (response: Response) => void = () => undefined;
      moreApi(detail(), () => new Promise<Response>((resolve) => (land = resolve)));
      await live();
      await press("More");
      if (outcome === "reported") {
        await press("Report and block");
        await radio("Something else");
        await press("Send report");
      } else {
        await press("Block");
        await press("Block");
      }
      await frame({ type: "conversation", conversationId: ID, state: "gone", closedHow: null });
      // Between Sending… and the list's thanks it would sound like a failure.
      expect(screen.getByText("Sending…").props.accessibilityLiveRegion).toBe("polite");
      expect(screen.getByText(GONE).props.accessibilityLiveRegion).toBe("none");
      await act(async () => land(done()));
      await settle();
      expect(router.dismissTo).toHaveBeenCalledWith("/chats");
      expect(router.back).not.toHaveBeenCalled();
      expect(takeNotice()).toBe(outcome);
    },
  );

  it("says on Android a conversation taken away with no action of the person's under way", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    moreApi(detail());
    await live();
    await frame({ type: "conversation", conversationId: ID, state: "gone", closedHow: null });
    expect(screen.getByText(GONE).props.accessibilityLiveRegion).toBe("polite");
  });

  it("says a report refused for its window, reads the conversation again, and offers no More once it cannot be reported", async () => {
    const ended = detail({ state: "closed", closedHow: "unmatch", counterpart: null });
    const { detailReads, set } = moreApi(ended, () => refusal("report_window_closed", 409));
    await renderWithTheme(<ConversationScreen id={ID} />);
    await screen.findByRole("heading", { name: "Conversation ended" });
    await press("More");
    await press("Report and block");
    await radio("Something else");
    set({ ...ended, reportable: false });
    const reads = detailReads();
    await press("Send report");
    expect(detailReads()).toBe(reads + 1);
    // The read took the report away; the dialog still says why.
    expect(screen.getByText("This conversation can no longer be reported.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    await press("Cancel");
    expect(screen.queryByText("This conversation can no longer be reported.")).toBeNull();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    expectPinnedHeader("Conversation ended", "Back");
    expect(router.dismissTo).not.toHaveBeenCalled();
  });
});
