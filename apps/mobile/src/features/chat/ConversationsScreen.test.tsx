import type { ConversationList, ConversationSummary } from "@kuutti/schema";
import { act, fireEvent, screen, userEvent, within } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { AccessibilityInfo, AppState, PixelRatio, Platform, StyleSheet } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { FakeWebSocket } from "@/test/websocket";
import { MAX_FONT_SCALE } from "@/theme/a11y";
import { ChatsButton } from "./ChatsButton";
import { ConversationsScreen } from "./ConversationsScreen";
import { leaveNotice } from "./notice";
import { ChatLiveProvider } from "./store";
import { dayOf, timeOf } from "./time";
import { FAILED_TO_LOAD } from "@/test/failed";

// The list of conversations and the home screen's way to it (#348): the
// groups by whose turn it is and the archive, the banner near the limit (ADR-062
// §5), a row's name, age, last line, time and unread mark in words, the empty
// state, a failure, and the reads on focus, on return and on a pull; live
// (#349): read again when the socket brings something, the turn a line moves,
// the cursors for its resume, and the connection line.

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
  refreshToken: `${token("family")}.${token("refresh")}`,
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
const noProblems = () =>
  expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual([]);
/** The words on the screen in the order a screen reader meets them. */
const inOrder = (node: HostNode | string): string[] =>
  typeof node === "string" ? [node] : (node.children ?? []).flatMap(inOrder);
const words = () => inOrder(screen.toJSON() as HostNode);

const OLD = "2026-01-05T10:00:00.000Z";
const NOW = new Date().toISOString();
const PHOTO = "0b4f3a0e-7c2f-4e2b-9a9a-1a2b3c4d5e6f";

function summary(id: string, over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    state: "open",
    closedHow: null,
    counterpart: { deleted: false, name: "Sanna", age: 31, thumb: null },
    lastMessage: { seq: 7, at: NOW, kind: "text", preview: "Nähdäänkö huomenna?", side: "theirs" },
    unread: 2,
    yourTurn: true,
    ...over,
  };
}
const ID = (n: number) => `3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a7${n}`;
/** The count of a list with `waiting` on the person's turn, against the seed's limit and warning. */
const COUNT = (waiting: number) => ({ waiting, limit: 8, warning: 6 });
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
      lastMessage: { seq: 3, at: OLD, kind: "text", preview: "Hei", side: "theirs" },
      unread: 0,
      yourTurn: false,
    }),
    // Ended: it names nobody (#351, ADR-031 Open 10).
    summary(ID(4), {
      state: "closed",
      closedHow: "unmatch",
      counterpart: null,
      lastMessage: { seq: 12, at: OLD, kind: "text", preview: "Kiitos", side: "mine" },
      unread: 0,
      yourTurn: false,
    }),
    summary(ID(5), {
      state: "archived",
      counterpart: { deleted: false, name: "Olli", age: 35, thumb: null },
      lastMessage: { seq: 1, at: OLD, kind: "text", preview: "Moi", side: "mine" },
      unread: 1,
      yourTurn: false,
    }),
  ],
  yourTurn: COUNT(2),
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
    expect(await screen.findByRole("heading", { name: "Your turn: 2" })).toBeTruthy();
    expectPinnedHeader("Conversations", "Back");
    expect(screen.getByRole("heading", { name: "Archived" })).toBeTruthy();
    // No line under the heading: the rows and what opening one says tell why (#581).
    expect(words()[words().indexOf("Archived") + 1]).toBe("Deleted user");
    const today = timeOf("en", NOW);
    const old = dayOf("en", OLD);
    for (const name of [
      `Sanna, 31, 2 unread messages, Nähdäänkö huomenna?, ${today}`,
      "Mikko, 29",
      `Deleted user, This person deleted their account., ${old}`,
      `Conversation ended, You: Kiitos, ${old}`,
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

  it("says once, on coming back, what a report, a block or an end left to say, aloud on iOS (#351)", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const announce = AccessibilityInfo.announceForAccessibility as jest.Mock;
    announce.mockClear();
    api(() => json(LIST));
    leaveNotice("reported");
    await renderWithTheme(<ConversationsScreen />);
    const thanks = "Thank you. A moderator will look at it.";
    expect(await screen.findByText(thanks)).toBeTruthy();
    expect(screen.getByTestId("notice").props.accessibilityLiveRegion).toBe("polite");
    expect(announce.mock.calls).toEqual([[thanks]]);
    // Back again with nothing left to say: the words are gone.
    await act(async () => focus());
    expect(screen.queryByText(thanks)).toBeNull();
    for (const [outcome, said] of [
      ["blocked", "Blocked."],
      ["unmatched", "The conversation has ended."],
      ["gone", "That conversation is no longer available."],
    ] as const) {
      leaveNotice(outcome);
      await act(async () => focus());
      expect(screen.getByText(said)).toBeTruthy();
    }
  });

  it("offers the support page under what a report, a block or an end left to say (#510)", async () => {
    api(() => json(LIST));
    await renderWithTheme(<ConversationsScreen />);
    const LINK = "Support when it's hard";
    // Nothing to say, nothing offered.
    expect(screen.queryByRole("link", { name: LINK })).toBeNull();
    for (const outcome of ["reported", "blocked", "unmatched"] as const) {
      leaveNotice(outcome);
      await act(async () => focus());
      expect(screen.getByRole("link", { name: LINK })).toBeTruthy();
    }
    await act(async () => {
      fireEvent.press(screen.getByRole("link", { name: LINK }));
    });
    expect(router.push).toHaveBeenLastCalledWith("/settings/support");
    // A conversation that was gone already: nothing went through.
    leaveNotice("gone");
    await act(async () => focus());
    expect(screen.getByText("That conversation is no longer available.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: LINK })).toBeNull();
  });

  it("says a photo's caption as the row's line, else Photo, with You: before one's own (#350)", async () => {
    const photo = (n: number, preview: string, side: "mine" | "theirs") =>
      summary(ID(n), {
        counterpart: { deleted: false, name: `Nimi${n}`, age: 30, thumb: null },
        lastMessage: { seq: 2, at: OLD, kind: "photo", preview, side },
        unread: 0,
      });
    api(() =>
      json({
        open: [
          photo(1, "", "theirs"),
          photo(2, "", "mine"),
          photo(3, "Mökillä", "theirs"),
          photo(4, "Mökillä", "mine"),
        ],
        archived: [],
        yourTurn: COUNT(2),
      }),
    );
    await renderWithTheme(<ConversationsScreen />);
    const old = dayOf("en", OLD);
    for (const name of [
      `Nimi1, 30, Photo, ${old}`,
      `Nimi2, 30, You: Photo, ${old}`,
      `Nimi3, 30, Mökillä, ${old}`,
      `Nimi4, 30, You: Mökillä, ${old}`,
    ]) {
      expect(await screen.findByRole("button", { name })).toBeTruthy();
    }
  });

  it.each([
    ["en-US", "Conversations", "No conversations yet."],
    ["fi-FI", "Keskustelut", "Ei vielä keskusteluja."],
    ["sv-FI", "Samtal", "Inga samtal än."],
  ])("says there is nothing yet, and nothing more: %s", async (languageTag, title, empty) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
    api(() => json({ open: [], archived: [], yourTurn: COUNT(0) }));
    await renderWithTheme(<ConversationsScreen />);
    expect(await screen.findByText(empty)).toBeTruthy();
    expect(words()).toEqual([title, empty]);
    expect(screen.queryAllByRole("heading").map((node) => node.props.children)).toEqual([title]);
  });

  it.each<[string, Partial<ConversationSummary>, string, string[]]>([
    ["on the person's turn", {}, "Mikko, 29", ["Mikko, 29"]],
    ["on the other's turn", { yourTurn: false }, "Mikko, 29", ["Mikko, 29"]],
    ["archived", { state: "archived", yourTurn: false }, "Mikko, 29", ["Mikko, 29"]],
    [
      "ended",
      { state: "closed", closedHow: "unmatch", counterpart: null, yourTurn: false },
      "Conversation ended",
      ["Conversation ended"],
    ],
    // An erasure still says it, with or without a message.
    [
      "left by a deleted account",
      { state: "closed", closedHow: "erasure", counterpart: { deleted: true }, yourTurn: false },
      "Deleted user, This person deleted their account.",
      ["Deleted user", "This person deleted their account."],
    ],
  ])(
    "draws and says no second line for a row with no message, %s, the group above saying whose move it is (#581)",
    async (_what, over, name, lines) => {
      const row = summary(ID(2), {
        counterpart: { deleted: false, name: "Mikko", age: 29, thumb: null },
        lastMessage: null,
        unread: 0,
        ...over,
      });
      const open = row.state === "open";
      api(() =>
        json({
          open: open ? [row] : [],
          archived: open ? [] : [row],
          yourTurn: COUNT(row.yourTurn ? 1 : 0),
        }),
      );
      await renderWithTheme(<ConversationsScreen />);
      const found = await screen.findByRole("button", { name });
      expect(
        within(found)
          .getAllByText(/./)
          .map((node) => node.props.children),
      ).toEqual(lines);
      noProblems();
    },
  );

  it("says why it did not load, and reads again on Try again", async () => {
    api(
      () => json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500),
      () => json({ open: [summary(ID(1))], archived: [], yourTurn: COUNT(1) }),
    );
    await renderWithTheme(<ConversationsScreen />);
    expect(await screen.findByText(FAILED_TO_LOAD)).toBeTruthy();
    await userEvent.setup().press(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Your turn: 1" })).toBeTruthy();
  });

  it("reads again on focus, on return to the foreground and on a pull, and keeps the list when a quiet read fails", async () => {
    const asked = api(
      () => json({ open: [summary(ID(1))], archived: [], yourTurn: COUNT(1) }),
      () =>
        json({
          open: [
            summary(ID(1)),
            summary(ID(2), {
              counterpart: { deleted: false, name: "Mikko", age: 29, thumb: null },
            }),
          ],
          archived: [],
          yourTurn: COUNT(2),
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

describe("whose turn it is (ADR-062 §5)", () => {
  const mine = (n: number, name: string) =>
    summary(ID(n), {
      counterpart: { deleted: false, name, age: 30, thumb: null },
      lastMessage: { seq: 2, at: OLD, kind: "text", preview: "Hei", side: "theirs" },
      unread: 0,
    });
  const theirs = (n: number, name: string) =>
    summary(ID(n), {
      counterpart: { deleted: false, name, age: 30, thumb: null },
      lastMessage: { seq: 2, at: OLD, kind: "text", preview: "Moi", side: "mine" },
      unread: 0,
      yourTurn: false,
    });
  it("groups the open ones by turn, the person's first with how many, each as the API ordered it", async () => {
    api(() =>
      json({
        open: [theirs(1, "Aino"), mine(2, "Bea"), theirs(3, "Cia"), mine(4, "Dan")],
        archived: [summary(ID(5), { state: "archived", yourTurn: false })],
        yourTurn: COUNT(2),
      }),
    );
    await renderWithTheme(<ConversationsScreen />);
    await screen.findByRole("heading", { name: "Your turn: 2" });
    expect(
      words().filter((text) => /^(Your turn|Their turn|Archived|\w+, \d+$)/.test(text)),
    ).toEqual([
      "Your turn: 2",
      "Bea, 30",
      "Dan, 30",
      "Their turn",
      "Aino, 30",
      "Cia, 30",
      "Archived",
      "Sanna, 31",
    ]);
    noProblems();
  });

  it.each([
    ["on the person's turn alone", [mine(1, "Bea")], 1, "Your turn: 1", "Their turn"],
    ["on the other's alone", [theirs(1, "Aino")], 0, "Their turn", /^Your turn/],
  ])("leaves the empty group out with everybody %s", async (_who, open, waiting, there, gone) => {
    api(() => json({ open, archived: [], yourTurn: COUNT(waiting) }));
    await renderWithTheme(<ConversationsScreen />);
    expect(await screen.findByRole("heading", { name: there })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: gone })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Archived" })).toBeNull();
  });

  it("leaves both out with only the archive left", async () => {
    api(() =>
      json({
        open: [],
        archived: [summary(ID(5), { state: "archived", yourTurn: false })],
        yourTurn: COUNT(0),
      }),
    );
    await renderWithTheme(<ConversationsScreen />);
    expect(await screen.findByRole("heading", { name: "Archived" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /^Your turn/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Their turn" })).toBeNull();
    expect(screen.queryByText(/You can't like anyone new/)).toBeNull();
  });

  it("keeps the count through a look back, which signs no thumb", async () => {
    const asked = api(
      () => json({ open: [mine(1, "Bea")], archived: [], yourTurn: COUNT(1) }),
      () => json({ open: [mine(1, "Bea"), mine(2, "Dan")], archived: [], yourTurn: COUNT(2) }),
    );
    await renderWithTheme(<ConversationsScreen />);
    await screen.findByRole("heading", { name: "Your turn: 1" });
    await act(async () => focus());
    expect(await screen.findByRole("heading", { name: "Your turn: 2" })).toBeTruthy();
    expect(asked.map((a) => a.query)).toEqual(["?thumbs=true", "?thumbs=false"]);
  });

  it.each([
    ["fi", "Sinun vuorosi: 1", "Toisen vuoro"],
    ["sv", "Din tur: 1", "Den andras tur"],
  ])("says the groups in %s", async (languageTag, yours, others) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
    api(() =>
      json({ open: [mine(1, "Bea"), theirs(2, "Aino")], archived: [], yourTurn: COUNT(1) }),
    );
    await renderWithTheme(<ConversationsScreen />);
    expect(await screen.findByRole("heading", { name: yours })).toBeTruthy();
    expect(screen.getByRole("heading", { name: others })).toBeTruthy();
  });

  describe("the banner", () => {
    const WORDS = (limit = 8) =>
      `You can't like anyone new while ${limit} ${limit === 1 ? "conversation is" : "conversations are"} waiting.`;
    const counted = (yourTurn: { waiting: number; limit: number; warning: number }) => () =>
      json({ open: [mine(1, "Bea")], archived: [], yourTurn });

    it.each([
      ["one under the warning", { waiting: 5, limit: 8, warning: 6 }, false],
      ["at the warning", { waiting: 6, limit: 8, warning: 6 }, true],
      [
        "one conversation, where the panel set a warning of one",
        { waiting: 1, limit: 2, warning: 1 },
        true,
      ],
      ["a limit of one, where the panel set it", { waiting: 1, limit: 1, warning: 1 }, true],
      ["past the warning", { waiting: 7, limit: 8, warning: 6 }, true],
      ["at the limit", { waiting: 8, limit: 8, warning: 6 }, true],
      ["past the limit, as a lowered limit leaves it", { waiting: 9, limit: 8, warning: 6 }, true],
      ["with the warning off", { waiting: 8, limit: 8, warning: 0 }, false],
      ["with the limit off, which refuses nothing", { waiting: 8, limit: 0, warning: 6 }, false],
      ["with neither on", { waiting: 8, limit: 0, warning: 0 }, false],
      ["with nobody waiting and the warning off", { waiting: 0, limit: 8, warning: 0 }, false],
    ])("%s", async (_when, count, shown) => {
      api(counted(count));
      await renderWithTheme(<ConversationsScreen />);
      await screen.findByRole("heading", { name: `Your turn: ${count.waiting}` });
      expect(screen.queryByText(WORDS(count.limit)) !== null).toBe(shown);
    });

    it("stands at the top of the list, above the groups, in plain words and a live region", async () => {
      api(counted({ waiting: 6, limit: 8, warning: 6 }));
      await renderWithTheme(<ConversationsScreen />);
      const line = await screen.findByText(WORDS());
      expect(line.props.accessibilityLiveRegion).toBe("polite");
      // How many wait is the heading's, right under it: the banner names the limit alone (#581).
      expect(words().indexOf("Your turn: 6")).toBe(words().indexOf(WORDS()) + 1);
    });

    it("holds at the largest text: nothing cut, its height the words'", async () => {
      jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(MAX_FONT_SCALE);
      api(counted({ waiting: 6, limit: 8, warning: 6 }));
      await renderWithTheme(<ConversationsScreen />);
      const line = await screen.findByText(WORDS());
      expect(line.props.numberOfLines).toBeUndefined();
      expect(StyleSheet.flatten(line.props.style)?.height).toBeUndefined();
      const box = screen.getByTestId("turn-warning");
      expect(box.props.className).not.toMatch(/(^| )(min-|max-)?h-/);
      expect(StyleSheet.flatten(box.props.style)?.height).toBeUndefined();
      noProblems();
    });

    it("is told to VoiceOver as it appears, not on a look back or as the count waiting moves, and again when it comes back or its limit moves (#581)", async () => {
      jest.replaceProperty(Platform, "OS", "ios");
      const announce = AccessibilityInfo.announceForAccessibility as jest.Mock;
      announce.mockClear();
      api(
        counted({ waiting: 6, limit: 8, warning: 6 }),
        counted({ waiting: 6, limit: 8, warning: 6 }),
        counted({ waiting: 7, limit: 8, warning: 6 }),
        counted({ waiting: 5, limit: 8, warning: 6 }),
        counted({ waiting: 6, limit: 8, warning: 6 }),
        counted({ waiting: 6, limit: 7, warning: 6 }),
      );
      await renderWithTheme(<ConversationsScreen />);
      await screen.findByText(WORDS());
      await act(async () => focus());
      await settle();
      expect(announce.mock.calls).toEqual([[WORDS()]]);
      await act(async () => focus());
      await screen.findByRole("heading", { name: "Your turn: 7" });
      expect(announce.mock.calls).toEqual([[WORDS()]]);
      // Under the warning it goes, and said nothing as it went.
      await act(async () => focus());
      await screen.findByRole("heading", { name: "Your turn: 5" });
      expect(screen.queryByText(WORDS())).toBeNull();
      expect(announce.mock.calls).toEqual([[WORDS()]]);
      await act(async () => focus());
      await screen.findByText(WORDS());
      expect(announce.mock.calls).toEqual([[WORDS()], [WORDS()]]);
      await act(async () => focus());
      await screen.findByText(WORDS(7));
      expect(announce.mock.calls).toEqual([[WORDS()], [WORDS()], [WORDS(7)]]);
    });

    it("leaves the telling to the live region on Android", async () => {
      jest.replaceProperty(Platform, "OS", "android");
      const announce = AccessibilityInfo.announceForAccessibility as jest.Mock;
      announce.mockClear();
      api(counted({ waiting: 6, limit: 8, warning: 6 }));
      await renderWithTheme(<ConversationsScreen />);
      await screen.findByText(WORDS());
      expect(announce).not.toHaveBeenCalled();
    });

    it.each([
      ["en", 8, WORDS(8)],
      ["en", 1, WORDS(1)],
      ["fi", 8, "Et voi tykätä kenestäkään uudesta, kun 8 keskustelua odottaa."],
      ["fi", 1, "Et voi tykätä kenestäkään uudesta, kun 1 keskustelu odottaa."],
      ["sv", 8, "Du kan inte gilla någon ny medan 8 samtal väntar."],
      ["sv", 1, "Du kan inte gilla någon ny medan 1 samtal väntar."],
    ])(
      "says it in %s at a limit of %i, naming what it counts",
      async (languageTag, limit, said) => {
        (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
        api(counted({ waiting: limit, limit, warning: 1 }));
        await renderWithTheme(<ConversationsScreen />);
        expect(await screen.findByText(said)).toBeTruthy();
      },
    );
  });

  it("moves a row and the count as a line comes over the socket, and the banner with them", async () => {
    FakeWebSocket.install();
    const asked = api(() =>
      json({
        open: [mine(1, "Bea"), theirs(2, "Aino")],
        archived: [],
        yourTurn: { waiting: 5, limit: 8, warning: 6 },
      }),
    );
    await renderWithTheme(
      <ChatLiveProvider>
        <ConversationsScreen />
      </ChatLiveProvider>,
    );
    await screen.findByRole("heading", { name: "Your turn: 5" });
    const ws = FakeWebSocket.latest();
    await act(async () => {
      ws.open();
      ws.receive({ type: "ready" });
    });
    const line = (id: string, seq: number, side: "mine" | "theirs") => ({
      type: "message" as const,
      conversationId: id,
      message: {
        id: `00000000-0000-4000-8000-00000000000${seq}`,
        seq,
        side,
        kind: "text" as const,
        body: "Moi",
        createdAt: NOW,
        clientId: null,
        photo: null,
      },
    });
    // A line from them: their turn is over, and the warning's number is reached.
    await act(async () => ws.receive(line(ID(2), 3, "theirs")));
    expect(screen.getByRole("heading", { name: "Your turn: 6" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Their turn" })).toBeNull();
    expect(
      screen.getByText(/^You can't like anyone new while 8 conversations are waiting/),
    ).toBeTruthy();
    // A line from the person: it is the other's turn again, and the banner goes.
    await act(async () => ws.receive(line(ID(1), 4, "mine")));
    expect(screen.getByRole("heading", { name: "Your turn: 5" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Their turn" })).toBeTruthy();
    expect(screen.queryByText(/You can't like anyone new/)).toBeNull();
    // All of it without a read.
    expect(asked).toHaveLength(1);
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
    api(() => json({ open: [summary(ID(1), { unread: 0 })], archived: [], yourTurn: COUNT(1) }));
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
  it("leave an edged circle in their place without a photo, which a high-contrast set's --muted would hide (#467)", async () => {
    api(() =>
      json({
        open: [
          summary(ID(1), { counterpart: { deleted: false, name: "Sanna", age: 31, thumb: null } }),
        ],
        archived: [],
        yourTurn: COUNT(1),
      }),
    );
    await renderWithTheme(<ConversationsScreen />);
    await screen.findByRole("button", { name: /^Sanna/ });
    const place = screen.getByTestId(`thumb-${ID(1)}`, { includeHiddenElements: true });
    expect(place.props.className).toMatch(/\bborder border-border bg-muted\b/);
  });

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
          yourTurn: COUNT(1),
        }),
      () => json({ open: [sanna({})], archived: [], yourTurn: COUNT(1) }),
      () =>
        json({
          open: [],
          archived: [sanna({ state: "closed", closedHow: "unmatch", yourTurn: false })],
          yourTurn: COUNT(0),
        }),
      () =>
        json({
          open: [
            sanna({ counterpart: { deleted: false, name: "Sanna", age: 31, thumb: thumb(2) } }),
          ],
          archived: [],
          yourTurn: COUNT(1),
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

describe("the list, live over the socket", () => {
  it("names every conversation's newest in the resume, applies a message without reading the list, reads again once on a state other than the row's or a new conversation, and says when the connection is lost", async () => {
    FakeWebSocket.install();
    const asked = api(() => json(LIST));
    await renderWithTheme(
      <ChatLiveProvider>
        <ChatsButton />
        <ConversationsScreen />
      </ChatLiveProvider>,
    );
    await screen.findByRole("heading", { name: "Your turn: 2" });
    await screen.findByRole("button", { name: "Conversations, 3 unread messages" });
    expect(asked.map((a) => a.query).sort()).toEqual(["?thumbs=false", "?thumbs=true"]);
    const ws = FakeWebSocket.latest();
    await act(async () => {
      ws.open();
      ws.receive({ type: "ready" });
    });
    expect(ws.sent.at(-1)).toEqual({
      type: "resume",
      conversations: [
        { id: ID(1), seq: 7 },
        { id: ID(2), seq: 0 },
        { id: ID(3), seq: 3 },
        { id: ID(4), seq: 12 },
        { id: ID(5), seq: 1 },
      ],
    });
    // Presence, a read mark and the resume's states as the rows hold them
    // change no row: nothing is read again.
    await act(async () => {
      ws.receive({ type: "presence", conversationId: ID(1), online: true });
      ws.receive({ type: "read", conversationId: ID(1), upTo: 3 });
      for (const c of [...LIST.open, ...LIST.archived]) {
        ws.receive({
          type: "conversation",
          conversationId: c.id,
          state: c.state,
          closedHow: c.closedHow,
        });
      }
    });
    await settle();
    expect(asked).toHaveLength(2);
    const live = (id: string, seq: number, body: string) => ({
      type: "message" as const,
      conversationId: id,
      message: {
        id: `00000000-0000-4000-8000-00000000000${seq}`,
        seq,
        side: "theirs" as const,
        kind: "text" as const,
        body,
        createdAt: NOW,
        clientId: null,
        photo: null,
      },
    });
    // A message is applied where it lands: the row's last line, one more unread, and no read of the list.
    await act(async () => ws.receive(live(ID(2), 1, "Moi!")));
    await settle();
    expect(asked).toHaveLength(2);
    expect(
      screen.getByRole("button", {
        name: `Mikko, 29, 1 unread message, Moi!, ${timeOf("en", NOW)}`,
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Conversations, 4 unread messages" })).toBeTruthy();
    // A message in a conversation the list does not hold reads it again, quietly, once.
    await act(async () => ws.receive(live(ID(9), 1, "Uusi")));
    await settle();
    expect(asked.slice(2).map((a) => a.query)).toEqual(["?thumbs=false", "?thumbs=false"]);
    await act(async () => ws.receive(live(ID(9), 2, "Uusi taas")));
    await settle();
    expect(asked).toHaveLength(4);
    // A change of state reads it again.
    await act(async () =>
      ws.receive({
        type: "conversation",
        conversationId: ID(1),
        state: "archived",
        closedHow: null,
      }),
    );
    await settle();
    expect(asked).toHaveLength(6);
    // The same word again, while the list still answers as before: not again.
    await act(async () =>
      ws.receive({
        type: "conversation",
        conversationId: ID(1),
        state: "archived",
        closedHow: null,
      }),
    );
    await settle();
    expect(asked).toHaveLength(6);
    expect(screen.queryByText("Connection lost. Reconnecting…")).toBeNull();
    await act(async () => ws.drop());
    expect(screen.getByText("Connection lost. Reconnecting…")).toBeTruthy();
  });
});
