import type { ConversationList, ConversationSummary } from "@kuutti/schema";
import { act, screen, userEvent } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { ChatsButton } from "./ChatsButton";
import { ConversationsScreen } from "./ConversationsScreen";
import { dayOf, timeOf } from "./time";

// The list of conversations and the home screen's way to it (#348): the two
// groups, a row's name, age, last line, time and unread mark in words, the
// empty state, a failure, and the reads on focus, on return and on a pull.

jest.mock("nativewind", () => ({
  ...jest.requireActual("nativewind"),
  useColorScheme: () => ({ colorScheme: "light", setColorScheme: jest.fn() }),
}));

const { __router: router, __focus: focus } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; back: jest.Mock };
  __focus: () => void;
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
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
const noProblems = () =>
  expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual([]);

const OLD = "2026-01-05T10:00:00.000Z";
const NOW = new Date().toISOString();
const PHOTO = "0b4f3a0e-7c2f-4e2b-9a9a-1a2b3c4d5e6f";

function summary(id: string, over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    state: "open",
    closedHow: null,
    counterpart: { deleted: false, name: "Sanna", age: 31, thumb: null },
    lastMessage: { at: NOW, kind: "text", preview: "Nähdäänkö huomenna?", side: "theirs" },
    unread: 2,
    ...over,
  };
}
const ID = (n: number) => `3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a7${n}`;
const LIST: ConversationList = {
  open: [
    summary(ID(1), {
      counterpart: {
        deleted: false,
        name: "Sanna",
        age: 31,
        thumb: {
          photoId: PHOTO,
          url: "https://media.test/thumb.webp?sig=x",
          blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
      },
    }),
    summary(ID(2), {
      counterpart: { deleted: false, name: "Mikko", age: 29, thumb: null },
      lastMessage: null,
      unread: 0,
    }),
  ],
  archived: [
    summary(ID(3), {
      state: "closed",
      closedHow: "erasure",
      counterpart: { deleted: true },
      lastMessage: { at: OLD, kind: "text", preview: "Hei", side: "theirs" },
      unread: 0,
    }),
    summary(ID(4), {
      state: "closed",
      closedHow: "unmatch",
      counterpart: { deleted: false, name: "Leena", age: 40, thumb: null },
      lastMessage: { at: OLD, kind: "text", preview: "Kiitos", side: "mine" },
      unread: 0,
    }),
    summary(ID(5), {
      state: "archived",
      counterpart: { deleted: false, name: "Olli", age: 35, thumb: null },
      lastMessage: { at: OLD, kind: "text", preview: "Moi", side: "mine" },
      unread: 1,
    }),
  ],
};

type Asked = { path: string; query: string };
/** The API as the screen sees it: the answers in turn, the last one repeated. */
function api(...answers: Array<() => Response>) {
  const asked: Asked[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    asked.push({ path: url.pathname, query: url.search });
    const answer = answers[Math.min(asked.length - 1, answers.length - 1)];
    if (!answer) throw new Error("no answer");
    return answer();
  }) as unknown as typeof fetch;
  return asked;
}

let appState: ((state: string) => void) | undefined;
beforeEach(async () => {
  store.clear();
  router.push.mockReset();
  router.back.mockReset();
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  appState = undefined;
  jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
    appState = listener as (state: string) => void;
    return { remove: jest.fn() } as never;
  });
  await clearSession();
  await saveSession(tokens);
});
afterEach(() => jest.restoreAllMocks());

describe("the list of conversations", () => {
  it("shows the open and the archived ones, each row read as one, and opens a row", async () => {
    const asked = api(() => json(LIST));
    await renderWithTheme(<ConversationsScreen />);
    expect(await screen.findByRole("heading", { name: "Open" })).toBeTruthy();
    expectPinnedHeader("Conversations", "Back");
    expect(screen.getByRole("heading", { name: "Archived" })).toBeTruthy();
    expect(
      screen.getByText("A conversation quiet for a week moves here. Writing in it brings it back."),
    ).toBeTruthy();
    const today = timeOf("en", NOW);
    const old = dayOf("en", OLD);
    for (const name of [
      `Sanna, 31, 2 unread messages, Nähdäänkö huomenna?, ${today}`,
      "Mikko, 29, No messages yet",
      `Deleted user, This person deleted their account., ${old}`,
      `Leena, 40, This conversation has ended., ${old}`,
      `Olli, 35, 1 unread message, You: Moi, ${old}`,
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    // The unread mark is a shape with words, not a colour.
    expect(screen.getByText("2 new", { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByText("1 new", { includeHiddenElements: true })).toBeTruthy();
    expect(asked[0]).toEqual({ path: "/conversations", query: "?thumbs=true" });
    noProblems();
    await userEvent.setup().press(screen.getByRole("button", { name: /^Sanna/ }));
    expect(router.push).toHaveBeenCalledWith(`/chats/${ID(1)}`);
    await userEvent.setup().press(screen.getByRole("button", { name: "Back" }));
    expect(router.back).toHaveBeenCalled();
  });

  it("says there is nothing yet", async () => {
    api(() => json({ open: [], archived: [] }));
    await renderWithTheme(<ConversationsScreen />);
    expect(
      await screen.findByText(
        "No conversations yet. A conversation opens here when you match with someone.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Open" })).toBeNull();
  });

  it("says why it did not load, and reads again on Try again", async () => {
    api(
      () => json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500),
      () => json({ open: [summary(ID(1))], archived: [] }),
    );
    await renderWithTheme(<ConversationsScreen />);
    expect(await screen.findByText("Your conversations could not be loaded.")).toBeTruthy();
    await userEvent.setup().press(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Open" })).toBeTruthy();
  });

  it("reads again on focus, on return to the foreground and on a pull, and keeps the list when a quiet read fails", async () => {
    const asked = api(
      () => json({ open: [summary(ID(1))], archived: [] }),
      () =>
        json({
          open: [
            summary(ID(1)),
            summary(ID(2), {
              counterpart: { deleted: false, name: "Mikko", age: 29, thumb: null },
            }),
          ],
          archived: [],
        }),
      () => json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500),
    );
    await renderWithTheme(<ConversationsScreen />);
    expect(await screen.findByRole("button", { name: /^Sanna/ })).toBeTruthy();
    await act(async () => focus());
    expect(await screen.findByRole("button", { name: /^Mikko/ })).toBeTruthy();
    await act(async () => appState?.("active"));
    await settle();
    // The failed read took nothing away.
    expect(screen.getByRole("button", { name: /^Mikko/ })).toBeTruthy();
    await act(async () => appState?.("background"));
    // The pull: the list's refresh control, as the platform calls it.
    const control = screen.getByTestId("conversations").props.refreshControl as {
      props: { onRefresh: () => void };
    };
    await act(async () => control.props.onRefresh());
    await settle();
    expect(asked.length).toBe(4);
    expect(screen.getByRole("button", { name: /^Mikko/ })).toBeTruthy();
  });
});

describe("the home screen's Conversations button", () => {
  it("says the unread count in words, shows the mark, asks without thumbs and opens the list", async () => {
    const asked = api(() => json(LIST));
    await renderWithTheme(<ChatsButton />);
    const button = await screen.findByRole("button", { name: "Conversations, 3 unread messages" });
    expect(screen.getByText("3 new", { includeHiddenElements: true })).toBeTruthy();
    expect(asked[0]).toEqual({ path: "/conversations", query: "?thumbs=false" });
    noProblems();
    await userEvent.setup().press(button);
    expect(router.push).toHaveBeenCalledWith("/chats");
  });

  it("says nothing is unread, with no mark", async () => {
    api(() => json({ open: [summary(ID(1), { unread: 0 })], archived: [] }));
    await renderWithTheme(<ChatsButton />);
    expect(
      await screen.findByRole("button", { name: "Conversations, nothing unread" }),
    ).toBeTruthy();
    expect(screen.queryByText(/new$/, { includeHiddenElements: true })).toBeNull();
  });

  it("is there all the same while the list cannot be read", async () => {
    api(() => json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500));
    await renderWithTheme(<ChatsButton />);
    await settle();
    expect(screen.getByRole("button", { name: "Conversations, nothing unread" })).toBeTruthy();
  });
});

describe("the thumbs of the list", () => {
  it("are signed on the first read and on a pull, carried on a look back, and dropped once the conversation ended", async () => {
    const thumb = (n: number) => ({
      photoId: PHOTO,
      url: `https://media.test/thumb-${n}.webp?sig=x`,
      blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    const sanna = (over: Partial<ConversationSummary>) =>
      summary(ID(1), {
        counterpart: { deleted: false, name: "Sanna", age: 31, thumb: null },
        ...over,
      });
    const asked = api(
      () =>
        json({
          open: [
            sanna({ counterpart: { deleted: false, name: "Sanna", age: 31, thumb: thumb(1) } }),
          ],
          archived: [],
        }),
      () => json({ open: [sanna({})], archived: [] }),
      () => json({ open: [], archived: [sanna({ state: "closed", closedHow: "unmatch" })] }),
      () =>
        json({
          open: [
            sanna({ counterpart: { deleted: false, name: "Sanna", age: 31, thumb: thumb(2) } }),
          ],
          archived: [],
        }),
    );
    // expo-image hands its host view the source as a list.
    const source = () =>
      (
        screen.queryByTestId(`thumb-${ID(1)}`, { includeHiddenElements: true })?.props as
          | { source?: Array<{ uri?: string }> }
          | undefined
      )?.source?.[0]?.uri;
    await renderWithTheme(<ConversationsScreen />);
    await screen.findByRole("button", { name: /^Sanna/ });
    expect(source()).toBe(thumb(1).url);
    // A look back: no thumb signed, the earlier one kept.
    await act(async () => focus());
    await settle();
    expect(source()).toBe(thumb(1).url);
    // Ended meanwhile: the photo goes.
    await act(async () => focus());
    await settle();
    expect(source()).toBeUndefined();
    // A pull signs again.
    const control = screen.getByTestId("conversations").props.refreshControl as {
      props: { onRefresh: () => void };
    };
    await act(async () => control.props.onRefresh());
    await settle();
    expect(source()).toBe(thumb(2).url);
    expect(asked.map((a) => a.query)).toEqual([
      "?thumbs=true",
      "?thumbs=false",
      "?thumbs=false",
      "?thumbs=true",
    ]);
  });
});
