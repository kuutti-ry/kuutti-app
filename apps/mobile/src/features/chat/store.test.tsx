import type { ChatMessage, ServerFrame } from "@kuutti/schema";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import type * as React from "react";
import { AppState } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { underProviders } from "@/test/render";
import { FakeWebSocket } from "@/test/websocket";
import { type ChatLive, ChatLiveProvider, EMPTY, merged, reduce, useChatLive } from "./store";

// What the socket said, held for the screens (#349): the reducer for every
// frame, the cursors the screens report, and the provider that holds the
// socket while signed in and not in the background, and forgets everything
// when the session ends.

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const tokens = {
  sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  accessToken: token("access"),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: `${token("family")}.${token("refresh")}`,
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
};
const A = "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a70";
const B = "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a71";
const message = (seq: number, body = `Viesti ${seq}`): ChatMessage => ({
  id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
  seq,
  side: "theirs",
  kind: "text",
  body,
  createdAt: "2026-10-17T11:03:00.000Z",
  clientId: null,
  photo: null,
});
const frames = (...all: ServerFrame[]): ChatLive =>
  all.reduce((live, frame) => reduce(live, { type: "frame", frame }), EMPTY);

describe("the chat's live store", () => {
  it("joins messages by sequence, each once, the later winning", () => {
    const live = frames(
      { type: "message", conversationId: A, message: message(3) },
      { type: "message", conversationId: A, message: message(1) },
      { type: "message", conversationId: A, message: message(3, "Korjattu") },
    );
    expect(live.conversations[A]?.messages.map((m) => [m.seq, m.body])).toEqual([
      [1, "Viesti 1"],
      [3, "Korjattu"],
    ]);
    expect(live.conversations[A]?.cursor).toBe(3);
  });

  it("keeps the URLs a page signed when the socket's copy of the same photo comes without them (#350)", () => {
    const photo = (urls: boolean, photoId = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01") => ({
      photoId,
      blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
      width: 1600,
      height: 1067,
      description: null,
      urls: urls
        ? {
            thumb: "https://media.test/thumb.webp?sig=s",
            full: "https://media.test/full.webp?sig=s",
            expiresAt: "2030-01-01T00:15:00.000Z",
          }
        : null,
    });
    const signed = { ...message(2), kind: "photo" as const, photo: photo(true) };
    const bare = { ...signed, photo: photo(false) };
    expect(merged([signed], [bare])).toEqual([signed]);
    // A copy with URLs, a photo gone since, or another photo at the place is the later word.
    expect(merged([bare], [signed])).toEqual([signed]);
    expect(merged([signed], [{ ...signed, photo: null }])).toEqual([{ ...signed, photo: null }]);
    const other = { ...signed, photo: photo(false, "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a02") };
    expect(merged([signed], [other])).toEqual([other]);
    expect(merged([message(2)], [bare])).toEqual([bare]);
  });

  it("raises the read mark only, and follows presence", () => {
    const live = frames(
      { type: "read", conversationId: A, upTo: 5 },
      { type: "read", conversationId: A, upTo: 2 },
      { type: "presence", conversationId: A, online: true },
    );
    expect(live.conversations[A]).toMatchObject({ readUpTo: 5, online: true, cursor: 0 });
    expect(
      reduce(live, { type: "frame", frame: { type: "presence", conversationId: A, online: false } })
        .conversations[A]?.online,
    ).toBe(false);
  });

  it("keeps the newest state of a conversation, gone included", () => {
    const live = frames(
      { type: "conversation", conversationId: A, state: "archived", closedHow: null },
      { type: "conversation", conversationId: B, state: "gone", closedHow: null },
      { type: "conversation", conversationId: A, state: "closed", closedHow: "erasure" },
    );
    expect(live.conversations[A]?.state).toEqual({ state: "closed", closedHow: "erasure" });
    expect(live.conversations[B]?.state).toEqual({ state: "gone", closedHow: null });
  });

  it("counts the socket's word that the contacts of a conversation changed, per conversation (#103)", () => {
    const live = frames(
      { type: "contacts", conversationId: A },
      { type: "contacts", conversationId: A },
      { type: "contacts", conversationId: B },
    );
    expect(live.conversations[A]?.contacts).toBe(2);
    expect(live.conversations[B]).toMatchObject({ contacts: 1, messages: [], cursor: 0 });
  });

  it("leaves ready, ping and error to the socket", () => {
    for (const frame of [
      { type: "ready" },
      { type: "ping" },
      { type: "error", code: "restarting" },
    ] as const) {
      expect(reduce(EMPTY, { type: "frame", frame })).toBe(EMPTY);
    }
  });

  it("raises a cursor only, names a conversation with none yet, and is unchanged when nothing moved", () => {
    const live = reduce(EMPTY, { type: "cursors", cursors: { [A]: 4, [B]: 0 } });
    expect(live.conversations[A]?.cursor).toBe(4);
    expect(live.conversations[B]?.cursor).toBe(0);
    const again = reduce(live, { type: "cursors", cursors: { [A]: 2, [B]: 0 } });
    expect(again).toBe(live);
    expect(reduce(again, { type: "cursors", cursors: { [A]: 9 } }).conversations[A]?.cursor).toBe(
      9,
    );
  });

  it("follows the status, the same one changing nothing, and forgets everything on clear", () => {
    const lost = reduce(EMPTY, { type: "status", status: "lost" });
    expect(lost.status).toBe("lost");
    expect(reduce(lost, { type: "status", status: "lost" })).toBe(lost);
    const held = reduce(lost, { type: "cursors", cursors: { [A]: 1 } });
    expect(reduce(held, { type: "clear" })).toBe(EMPTY);
  });

  it("counts each time the socket became open, each a resume, and nothing else (#103)", () => {
    const statuses = (...all: Array<"connecting" | "open" | "lost">) =>
      all.reduce((live, status) => reduce(live, { type: "status", status }), EMPTY);
    expect(EMPTY.opened).toBe(0);
    expect(statuses("open").opened).toBe(1);
    // Open again is no new resume; lost and connecting are none.
    expect(statuses("open", "open", "lost", "connecting").opened).toBe(1);
    expect(statuses("open", "lost", "open", "connecting", "open").opened).toBe(3);
  });

  it("is inert without its provider: nothing live, a report goes nowhere", async () => {
    const { result } = await renderHook(() => useChatLive());
    expect(result.current).toMatchObject({ status: "connecting", conversations: {} });
    expect(() => result.current.report({ [A]: 1 })).not.toThrow();
  });
});

describe("the chat's live provider", () => {
  let appState: Array<(state: string) => void>;
  const toApp = (state: string) =>
    act(async () => {
      for (const listener of appState) listener(state);
    });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    underProviders(<ChatLiveProvider>{children}</ChatLiveProvider>);
  // The preset's AppState mock has a function there, which replaceProperty refuses.
  const mocked = AppState.currentState;
  const startIn = (state: string) => {
    (AppState as { currentState: unknown }).currentState = state;
  };

  beforeEach(async () => {
    store.clear();
    FakeWebSocket.install();
    appState = [];
    startIn("active");
    jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
      appState.push(listener as (state: string) => void);
      return { remove: jest.fn() } as never;
    });
    await clearSession();
  });
  afterEach(() => {
    startIn(mocked);
    jest.restoreAllMocks();
  });

  it("opens nothing while signed out", async () => {
    const { result } = await renderHook(() => useChatLive(), { wrapper });
    await act(async () => undefined);
    expect(FakeWebSocket.instances).toEqual([]);
    expect(result.current.status).toBe("connecting");
  });

  it("connects once signed in, resumes with the cursors the screens reported, holds what arrives, and forgets it all on sign-out", async () => {
    await saveSession(tokens);
    const { result } = await renderHook(() => useChatLive(), { wrapper });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await act(async () => result.current.report({ [A]: 4, [B]: 0 }));
    const ws = FakeWebSocket.latest();
    await act(async () => {
      ws.open();
      ws.receive({ type: "ready" });
    });
    expect(result.current.status).toBe("open");
    expect(ws.sent).toEqual([
      { type: "auth", token: tokens.accessToken },
      {
        type: "resume",
        conversations: [
          { id: A, seq: 4 },
          { id: B, seq: 0 },
        ],
      },
    ]);
    await act(async () => ws.receive({ type: "message", conversationId: A, message: message(5) }));
    expect(result.current.conversations[A]?.messages).toEqual([message(5)]);
    await act(async () => ws.drop());
    expect(result.current.status).toBe("lost");
    // Someone else may sign in on this phone next.
    await act(async () => clearSession());
    expect(result.current).toMatchObject({ status: "connecting", conversations: {} });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("closes in the background, not when merely inactive, and connects again in front", async () => {
    await saveSession(tokens);
    const { result } = await renderHook(() => useChatLive(), { wrapper });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const first = FakeWebSocket.latest();
    await act(async () => {
      first.open();
      first.receive({ type: "ready" });
    });
    await toApp("inactive");
    expect(first.close).not.toHaveBeenCalled();
    await toApp("background");
    expect(first.close).toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
    await toApp("active");
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(result.current.status).toBe("connecting");
  });

  it("waits for the front when the app starts in the background", async () => {
    startIn("background");
    await saveSession(tokens);
    await renderHook(() => useChatLive(), { wrapper });
    await act(async () => undefined);
    expect(FakeWebSocket.instances).toEqual([]);
    await toApp("active");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
