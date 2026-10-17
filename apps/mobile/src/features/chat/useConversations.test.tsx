import type { ConversationList, ConversationSummary } from "@kuutti/schema";
import { act, renderHook } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";
import { ApiError } from "@/lib/api";
import { saveSession } from "@/lib/session";
import { fetchConversations, sendMessage } from "./client";
import type { ConversationLive } from "./store";
import { useConversations, withLive } from "./useConversations";

// The list's reads (#348): of two reads under way the later one speaks, and
// the client's refusals carry the envelope's code when there is one.

const { __focus: focus } = jest.requireMock("expo-router") as { __focus: () => void };
const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const list = (unread: number): ConversationList => ({
  open: [
    {
      id: "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a70",
      state: "open",
      closedHow: null,
      counterpart: { deleted: false, name: "Sanna", age: 31, thumb: null },
      lastMessage: null,
      unread,
    },
  ],
  archived: [],
});

/** Every read waits until the test answers it, in the order they were asked. */
function pendingReads() {
  const waiting: Array<(response: Response) => void> = [];
  globalThis.fetch = jest.fn(
    () =>
      new Promise<Response>((resolve) => {
        waiting.push(resolve);
      }),
  ) as unknown as typeof fetch;
  return waiting;
}

beforeEach(async () => {
  store.clear();
  jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation(() => ({ remove: jest.fn() }) as never);
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});
afterEach(() => jest.restoreAllMocks());

describe("useConversations", () => {
  it("lets the later of two reads speak, whichever answers first, an answer or a failure", async () => {
    const waiting = pendingReads();
    const { result } = await renderHook(() => useConversations());
    await act(async () => result.current.retry());
    const [first, second] = waiting;
    await act(async () => second?.(json(list(1))));
    expect(result.current).toMatchObject({ status: "ready", list: list(1) });
    await act(async () => first?.(json(list(9))));
    expect(result.current).toMatchObject({ list: list(1) });
    await act(async () => focus());
    await act(async () => focus());
    const [, , third, fourth] = waiting;
    await act(async () => fourth?.(json(list(3))));
    await act(async () => third?.(json({ error: { code: "internal_error" } }, 500)));
    expect(result.current).toMatchObject({ status: "ready", list: list(3) });
  });
});

describe("the chat's client", () => {
  it("carries the envelope's code on a refusal, and none on an answer without one", async () => {
    globalThis.fetch = jest.fn(async () =>
      json({ error: { code: "conversation_closed", message: "x", requestId: "r" } }, 409),
    ) as unknown as typeof fetch;
    await expect(
      sendMessage("3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a70", {
        clientId: "11111111-1111-4111-8111-111111111111",
        body: "Hei",
      }),
    ).rejects.toMatchObject({ status: 409, code: "conversation_closed" });
    globalThis.fetch = jest.fn(
      async () => new Response("Bad gateway", { status: 502 }),
    ) as unknown as typeof fetch;
    const failed = await fetchConversations().catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ApiError);
    expect(failed).toMatchObject({ status: 502, code: undefined });
  });
});

describe("the list as the socket moved it", () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 17, 10, minutes)).toISOString();
  const row = (id: string, over: Partial<ConversationSummary> = {}): ConversationSummary => ({
    id,
    state: "open",
    closedHow: null,
    counterpart: { deleted: false, name: "Sanna", age: 31, thumb: null },
    lastMessage: { seq: 2, at: at(1), kind: "text", preview: "Vanha", side: "theirs" },
    unread: 1,
    ...over,
  });
  const liveOf = (
    messages: Array<{ seq: number; side: "mine" | "theirs"; body: string; minute: number }>,
  ): ConversationLive => ({
    messages: messages.map((m) => ({
      id: `00000000-0000-4000-8000-${String(m.seq).padStart(12, "0")}`,
      seq: m.seq,
      side: m.side,
      kind: "text",
      body: m.body,
      createdAt: at(m.minute),
      clientId: null,
    })),
    readUpTo: 0,
    online: false,
    state: null,
    cursor: 0,
  });
  const A = "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a71";
  const B = "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a72";
  const C = "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a73";
  const D = "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a74";

  it("makes a newer message the row's last line, counts theirs as unread, brings it back from the archive and to the top, and leaves the rest as they were", () => {
    const list: ConversationList = {
      open: [row(A), row(B)],
      archived: [row(C, { state: "archived" }), row(D, { state: "closed", closedHow: "unmatch" })],
    };
    const moved = withLive(list, {
      // Older than the row's last line, and a closed conversation's: nothing.
      [A]: liveOf([{ seq: 2, side: "theirs", body: "Vanha", minute: 1 }]),
      [C]: liveOf([
        { seq: 3, side: "theirs", body: "Hei", minute: 5 },
        { seq: 4, side: "mine", body: `${"x".repeat(100)}`, minute: 6 },
      ]),
      [B]: liveOf([{ seq: 3, side: "theirs", body: "Moi", minute: 4 }]),
      [D]: liveOf([{ seq: 3, side: "theirs", body: "Myöhässä", minute: 7 }]),
    });
    expect(moved.open.map((c) => c.id)).toEqual([C, B, A]);
    expect(moved.archived.map((c) => c.id)).toEqual([D]);
    expect(moved.open[0]).toMatchObject({
      state: "open",
      unread: 2,
      lastMessage: { seq: 4, side: "mine", preview: "x".repeat(80) },
    });
    expect(moved.open[1]).toMatchObject({ unread: 2, lastMessage: { seq: 3, preview: "Moi" } });
    expect(moved.open[2]).toEqual(row(A));
    expect(moved.archived[0]).toEqual(row(D, { state: "closed", closedHow: "unmatch" }));
  });

  it("counts from no message at all", () => {
    const list: ConversationList = {
      open: [row(A, { lastMessage: null, unread: 0 })],
      archived: [],
    };
    const moved = withLive(list, {
      [A]: liveOf([{ seq: 1, side: "theirs", body: "", minute: 2 }]),
    });
    expect(moved.open[0]).toMatchObject({ unread: 1, lastMessage: { seq: 1, preview: "" } });
  });
});
