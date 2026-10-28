import type { ChatMessage } from "@kuutti/schema";
import { act, fireEvent, screen, userEvent, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { AccessibilityInfo } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { FakeWebSocket } from "@/test/websocket";
import { ChatPhotoScreen } from "./ChatPhotoScreen";
import { takeNotice } from "./notice";
import { ChatLiveProvider } from "./store";

// A conversation's photo full size (#350): read again by its place, the full
// size contained with its label, the description under it when the setting
// asks, back with one button; gone, failed with Try again, read once more
// when the URL expired. Report this photo (#476) on the other person's photo
// while the link says the conversation takes a report: the report step with
// the photo set, its place sent, and back to the list.

jest.mock("nativewind", () => ({
  ...jest.requireActual("nativewind"),
  useColorScheme: () => ({ colorScheme: "light", setColorScheme: jest.fn() }),
}));

const { __router: router, __blur: blur } = jest.requireMock("expo-router") as {
  __router: { back: jest.Mock; dismissTo: jest.Mock };
  __blur: () => void;
};
const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

const CONVERSATION = "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a70";
const MESSAGE = "00000000-0000-4000-8000-000000000004";
const PHOTO_ID = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01";
const BLURHASH = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";
const urls = (n: number) => ({
  thumb: `https://media.test/${n}/thumb.webp?sig=s`,
  full: `https://media.test/${n}/full.webp?sig=s`,
  expiresAt: "2030-01-01T00:15:00.000Z",
});
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
const photoMessage = (over: Partial<ChatMessage> = {}, n = 1): ChatMessage => ({
  id: MESSAGE,
  seq: 4,
  side: "theirs",
  kind: "photo",
  body: "Mökillä",
  createdAt: "2026-10-17T11:03:00.000Z",
  clientId: null,
  photo: {
    photoId: PHOTO_ID,
    blurhash: BLURHASH,
    width: 1600,
    height: 1067,
    description: null,
    urls: urls(n),
  },
  ...over,
});

/** The API's answers in turn, the last one repeated; every query recorded. */
function api(...answers: Array<() => Response | Promise<Response>>): string[] {
  const asked: string[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    asked.push(`${url.pathname}${url.search}`);
    const answer = answers[Math.min(asked.length - 1, answers.length - 1)];
    if (!answer) throw new Error("no answer");
    return answer();
  }) as unknown as typeof fetch;
  return asked;
}
const props = {
  messageId: MESSAGE,
  conversation: CONVERSATION,
  seq: 4,
  blurhash: BLURHASH,
  report: null,
};
/** The full size's host view: what expo-image was handed. */
const full = () =>
  screen.getByTestId("photo-full").props as {
    source?: Array<{ uri?: string; cacheKey?: string }>;
    contentFit?: string;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  };

/**
 * Back to the list from the photo: down to its conversation first, then the
 * list is found under the conversation or takes its place (#491;
 * notice.test.tsx walks the real stack).
 */
function expectHandedFromThePhoto() {
  expect(router.dismissTo.mock.calls).toEqual([
    [{ pathname: "/chats/[id]", params: { id: CONVERSATION } }],
    ["/chats"],
  ]);
  expect(router.back).not.toHaveBeenCalled();
}

beforeEach(async () => {
  store.clear();
  router.back.mockReset();
  router.dismissTo.mockReset();
  takeNotice();
  await clearSession();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("a conversation's photo full size", () => {
  it("reads the message by its place, shows the full size whole with the caption in its label, and goes back with a labelled button", async () => {
    let answer: (response: Response) => void = () => undefined;
    const asked = api(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    await renderWithTheme(<ChatPhotoScreen {...props} />);
    expect(screen.getByText("Loading the photo…").props.accessibilityLiveRegion).toBe("polite");
    expect(screen.getByRole("heading", { name: "Photo" })).toBeTruthy();
    await act(async () => answer(json({ messages: [photoMessage()] })));
    await waitFor(() => expect(full().source?.[0]?.uri).toBe(urls(1).full));
    expect(asked).toEqual([`/conversations/${CONVERSATION}/messages?before=5&limit=1`]);
    expect(full().source?.[0]?.cacheKey).toBe(`${PHOTO_ID}/full`);
    expect(full().contentFit).toBe("contain");
    expect(full().accessibilityRole).toBe("image");
    expect(screen.getByLabelText("Photo, full size. Mökillä")).toBeTruthy();
    const found = pressables(screen.toJSON() as HostNode);
    expect(found).toHaveLength(1);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    await userEvent.setup().press(screen.getByRole("button", { name: "Back to the conversation" }));
    expect(router.back).toHaveBeenCalled();
  });

  it("reads the check's description after the label, and shows it under the photo when the setting asks (#296)", async () => {
    const withDescription = photoMessage({
      body: null,
      photo: { ...(photoMessage().photo as NonNullable<ChatMessage["photo"]>), description },
    });
    api(() => json({ messages: [withDescription] }));
    await renderWithTheme(<ChatPhotoScreen {...props} />);
    expect(await screen.findByLabelText(`Photo, full size. ${WORDS}`)).toBeTruthy();
    expect(screen.queryByText(WORDS, { includeHiddenElements: true })).toBeNull();

    store.set("kuutti.preference.photoDescriptions", JSON.stringify({ shown: true }));
    await renderWithTheme(<ChatPhotoScreen {...props} />);
    await waitFor(() =>
      expect(screen.getByText(WORDS, { includeHiddenElements: true })).toBeTruthy(),
    );
    // For the eye: the label says it already.
    expect(screen.queryByText(WORDS)).toBeNull();
  });

  it.each([
    [
      "another message at its place",
      () => json({ messages: [photoMessage({ id: "00000000-0000-4000-8000-000000000005" })] }),
    ],
    ["no message at its place", () => json({ messages: [] })],
    [
      "a photo that went with its sender",
      () => json({ messages: [photoMessage({ photo: null })] }),
    ],
    ["a conversation that is not the person's", () => refusal("not_found", 404)],
    ["a link the API cannot read", () => refusal("validation_failed", 400)],
  ])("says the photo is no longer there for %s", async (_what, answer) => {
    api(answer);
    await renderWithTheme(<ChatPhotoScreen {...props} />);
    expect(
      (await screen.findByText("This photo is no longer available.")).props.accessibilityLiveRegion,
    ).toBe("polite");
    expect(screen.queryByTestId("photo-full")).toBeNull();
    expect(screen.getByRole("button", { name: "Back to the conversation" })).toBeTruthy();
  });

  it.each([
    ["no sequence", { seq: 0 }],
    ["no conversation", { conversation: "" }],
    ["no message", { messageId: "" }],
  ])("asks nothing for a link with %s", async (_what, over) => {
    const asked = api(() => json({ messages: [photoMessage()] }));
    await renderWithTheme(<ChatPhotoScreen {...props} {...over} blurhash="" />);
    expect(await screen.findByText("This photo is no longer available.")).toBeTruthy();
    expect(asked).toEqual([]);
  });

  it("offers Try again when the photo did not load", async () => {
    api(
      () => refusal("internal_error", 500),
      () => json({ messages: [photoMessage()] }),
    );
    await renderWithTheme(<ChatPhotoScreen {...props} />);
    expect(await screen.findByText("The photo could not be loaded.")).toBeTruthy();
    await userEvent.setup().press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(full().source?.[0]?.uri).toBe(urls(1).full));
  });

  it("reads the message once more when the full size's URL has expired, and only once", async () => {
    const asked = api(
      () => json({ messages: [photoMessage()] }),
      () => json({ messages: [photoMessage({}, 2)] }),
    );
    await renderWithTheme(<ChatPhotoScreen {...props} />);
    await waitFor(() => expect(full().source?.[0]?.uri).toBe(urls(1).full));
    const expire = async () => {
      await act(async () => {
        fireEvent(screen.getByTestId("photo-full"), "error", { nativeEvent: { error: "expired" } });
      });
      await settle();
    };
    await expire();
    expect(full().source?.[0]?.uri).toBe(urls(2).full);
    await expire();
    expect(asked).toHaveLength(2);
  });
});

type Call = { method: string; path: string; query: string; body: unknown };
/** The API by route: the message's reads answered in turn (the last repeated), a report or a block as told; every call recorded. */
function routes(
  reads: Array<() => Response | Promise<Response>>,
  acted: () => Response | Promise<Response> = () => new Response(null, { status: 204 }),
): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === "GET" ? "" : await request.text();
    calls.push({
      method: request.method,
      path: url.pathname,
      query: url.search,
      body: text ? JSON.parse(text) : null,
    });
    if (request.method !== "GET") return acted();
    const read = reads[Math.min(calls.filter((c) => c.method === "GET").length, reads.length) - 1];
    if (!read) throw new Error("no answer");
    return read();
  }) as unknown as typeof fetch;
  return calls;
}
const press = (name: string, role: "button" | "radio" = "button") =>
  act(async () => {
    fireEvent.press(screen.getByRole(role, { name }));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  });
/** Report this photo, once the photo is shown. */
const reportThis = async () => {
  await screen.findByRole("button", { name: "Report this photo" });
  await press("Report this photo");
};
const NOTE = "Anything the moderators should know (optional, up to 500 characters)";
const POINTS = "The report points the moderators to this photo.";
const COPY =
  "The moderators get a copy of this whole conversation, your own messages and photos included, and keep it for twelve months.";
const ENDS =
  "A report also blocks them, for good, and ends this conversation for both of you: you will not see each other here again, even if either of you deletes their account. A block cannot be undone. They are not told.";
const BLOCKS =
  "A report also blocks them, for good: you will not see each other here again, even if either of you deletes their account. A block cannot be undone. They are not told.";
const THANKS = "Thank you. A moderator will look at it, and you will not see each other again.";
const REPORT = `/conversations/${CONVERSATION}/report`;
/** The report step's lines, in the order they are read. */
const reportLines = () =>
  screen
    .getAllByText(/./)
    .map((node) => node.props.children)
    .filter((line) => [POINTS, COPY, ENDS, BLOCKS].includes(line));

describe("Report this photo (#476)", () => {
  it("offers Report this photo on a photo the other person sent while the conversation takes a report, and reports it with its place, back to the list", async () => {
    const calls = routes([() => json({ messages: [photoMessage()] })]);
    await renderWithTheme(<ChatPhotoScreen {...props} report="open" />);
    await waitFor(() => expect(full().source?.[0]?.uri).toBe(urls(1).full));
    // Back, then Report this photo, named and at least 44 points.
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.map((node) => node.props.accessibilityLabel ?? null)).toEqual([
      "Back to the conversation",
      null,
    ]);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    // Read after the photo it is about.
    const tree = JSON.stringify(screen.toJSON());
    expect(tree.indexOf("photo-full")).toBeLessThan(tree.indexOf("Report this photo"));
    await reportThis();
    expect(screen.getByText("Report and block")).toBeTruthy();
    expect(reportLines()).toEqual([POINTS, COPY, ENDS]);
    await press("Harassing, threatening or hateful", "radio");
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText(NOTE), "Sent this after I said no.");
    });
    await press("Send report");
    expect(calls.filter((c) => c.method === "POST")).toEqual([
      {
        method: "POST",
        path: REPORT,
        query: "",
        body: { reason: "harassment", note: "Sent this after I said no.", seq: 4 },
      },
    ]);
    expectHandedFromThePhoto();
    expect(takeNotice()).toBe("reported");
    // The message alone was read: the conversation's detail, which signs a thumb, never.
    expect(calls.filter((c) => c.method === "GET").map((c) => `${c.path}${c.query}`)).toEqual([
      `/conversations/${CONVERSATION}/messages?before=5&limit=1`,
    ]);
  });

  it.each([
    [
      "on one's own photo",
      "open" as const,
      () => json({ messages: [photoMessage({ side: "mine" })] }),
    ],
    ["when the conversation takes no report", null, () => json({ messages: [photoMessage()] })],
    [
      "on a photo no longer there",
      "open" as const,
      () => json({ messages: [photoMessage({ photo: null })] }),
    ],
    ["when the photo did not load", "open" as const, () => refusal("internal_error", 500)],
  ])("offers no Report this photo %s", async (_what, report, answer) => {
    routes([answer]);
    await renderWithTheme(<ChatPhotoScreen {...props} report={report} />);
    await settle();
    await settle();
    expect(screen.queryByText("Loading the photo…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Report this photo" })).toBeNull();
    expect(screen.queryByText("Report this photo")).toBeNull();
  });

  it("says in an ended conversation that the report blocks, and not that it ends", async () => {
    routes([() => json({ messages: [photoMessage()] })]);
    await renderWithTheme(<ChatPhotoScreen {...props} report="ended" />);
    await reportThis();
    expect(reportLines()).toEqual([POINTS, COPY, BLOCKS]);
  });

  it("says the report blocks once the socket tells that the conversation ended while the photo was open", async () => {
    FakeWebSocket.install();
    routes([() => json({ messages: [photoMessage()] })]);
    await renderWithTheme(
      <ChatLiveProvider>
        <ChatPhotoScreen {...props} report="open" />
      </ChatLiveProvider>,
    );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await act(async () => {
      FakeWebSocket.latest().open();
      FakeWebSocket.latest().receive({ type: "ready" });
    });
    await act(async () =>
      FakeWebSocket.latest().receive({
        type: "conversation",
        conversationId: CONVERSATION,
        state: "closed",
        closedHow: "unmatch",
      }),
    );
    await reportThis();
    expect(reportLines()).toEqual([POINTS, COPY, BLOCKS]);
  });

  it("says a report past the window, and offers Report this photo no more once the dialog closes", async () => {
    routes([() => json({ messages: [photoMessage()] })], () =>
      refusal("report_window_closed", 409),
    );
    await renderWithTheme(<ChatPhotoScreen {...props} report="ended" />);
    await reportThis();
    await press("Something else", "radio");
    await press("Send report");
    expect(screen.getByText("This conversation can no longer be reported.")).toBeTruthy();
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
    await press("Cancel");
    expect(screen.queryByRole("button", { name: "Report this photo" })).toBeNull();
    // The photo stays.
    expect(full().source?.[0]?.uri).toBe(urls(1).full);
  });

  it("takes a conversation gone meanwhile back to the list, which says so", async () => {
    routes([() => json({ messages: [photoMessage()] })], () => refusal("not_found", 404));
    await renderWithTheme(<ChatPhotoScreen {...props} report="open" />);
    await reportThis();
    await press("Something else", "radio");
    await press("Send report");
    expectHandedFromThePhoto();
    expect(takeNotice()).toBe("gone");
  });

  it("moves nobody when the report lands after the person left the screen, and says it aloud instead", async () => {
    let answer: (response: Response) => void = () => undefined;
    routes(
      [() => json({ messages: [photoMessage()] })],
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
    await renderWithTheme(<ChatPhotoScreen {...props} report="open" />);
    await reportThis();
    await press("Something else", "radio");
    await press("Send report");
    await act(async () => blur());
    await act(async () => answer(new Response(null, { status: 204 })));
    await settle();
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
    expect(takeNotice()).toBeNull();
    expect(announce).toHaveBeenCalledWith(THANKS);
    announce.mockRestore();
  });

  it("keeps a report under way when the photo's read again finds it gone, without the button, and still takes the person to the list", async () => {
    routes([() => json({ messages: [photoMessage()] }), () => refusal("not_found", 404)]);
    await renderWithTheme(<ChatPhotoScreen {...props} report="open" />);
    await reportThis();
    await press("Something else", "radio");
    // The full size's URL expired on a cache miss, and the message is gone meanwhile.
    await act(async () => {
      fireEvent(screen.getByTestId("photo-full"), "error", { nativeEvent: { error: "expired" } });
    });
    await settle();
    expect(screen.getByText("This photo is no longer available.")).toBeTruthy();
    expect(screen.queryByTestId("photo-full")).toBeNull();
    // The dialog stays where it was, the reason with it; the button behind it is gone.
    expect(screen.getByRole("radio", { name: "✓ Something else" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Report this photo" })).toBeNull();
    await press("Send report");
    expectHandedFromThePhoto();
    expect(takeNotice()).toBe("reported");
  });
});
