import type { SessionTokens } from "@kuutti/schema";
import * as SecureStore from "expo-secure-store";
import { clearSession, currentSession, saveSession } from "@/lib/session";
import { FakeWebSocket } from "@/test/websocket";
import { connect, type SocketHandlers } from "./socket";

// The chat's socket (#349): auth from the open, a resume after every ready,
// pong to ping, frames outside the contract dropped, the reconnect's backoff
// and when the connection counts as lost, the refresh after a refused token
// and ahead of expiry, and nothing at all without a session.

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const NOW = new Date("2026-10-17T12:00:00.000Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000).toISOString();
const tokens = (seed: string, expiresInMinutes = 15): SessionTokens => ({
  sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  accessToken: token(`access${seed}`),
  accessExpiresAt: minutes(expiresInMinutes),
  refreshToken: token(`refresh${seed}`),
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ID = "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a70";
const MESSAGE = {
  type: "message",
  conversationId: ID,
  message: {
    id: "00000000-0000-4000-8000-000000000002",
    seq: 2,
    side: "theirs",
    kind: "text",
    body: "Moi",
    createdAt: "2026-10-17T11:59:00.000Z",
    clientId: null,
    photo: null,
  },
};

/** The refreshes the API is asked for, each answered in turn by the next of these. */
function refreshes(...answers: Array<() => Response | Promise<Response>>): () => number {
  let n = 0;
  globalThis.fetch = jest.fn(async () => {
    const answer = answers[Math.min(n, answers.length - 1)];
    n += 1;
    if (!answer) throw new Error("no answer prepared");
    return answer();
  }) as unknown as typeof fetch;
  return () => n;
}

let handlers: SocketHandlers & { onFrame: jest.Mock; onStatus: jest.Mock };
let stop: (() => void) | undefined;
const sockets = () => FakeWebSocket.instances.length;
const advance = (ms: number) => jest.advanceTimersByTimeAsync(ms);
/** Open the latest socket and let the API say ready. */
function ready(): FakeWebSocket {
  const ws = FakeWebSocket.latest();
  ws.open();
  ws.receive({ type: "ready" });
  return ws;
}

beforeEach(async () => {
  jest.useFakeTimers({ now: NOW });
  store.clear();
  FakeWebSocket.install();
  refreshes(() => {
    throw new Error("no refresh expected");
  });
  handlers = {
    onFrame: jest.fn(),
    onStatus: jest.fn(),
    // The backoff's spread at its widest: each wait is the whole backoff.
    random: () => 1,
    cursors: () => [{ id: ID, seq: 1 }],
  };
  await saveSession(tokens("1"));
});
afterEach(() => {
  stop?.();
  stop = undefined;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("the chat's socket", () => {
  it("sends the token once open, resumes after ready with the cursors held, answers ping with pong and hands on the rest", async () => {
    stop = connect(handlers);
    const ws = FakeWebSocket.latest();
    expect(ws.url).toBe("ws://localhost:3000/ws");
    // Nothing is sent while connecting: React Native would throw.
    expect(ws.sent).toEqual([]);
    ws.open();
    expect(ws.sent).toEqual([{ type: "auth", token: token("access1") }]);
    ws.receive({ type: "ready" });
    expect(handlers.onStatus).toHaveBeenLastCalledWith("open");
    expect(ws.sent.at(-1)).toEqual({ type: "resume", conversations: [{ id: ID, seq: 1 }] });
    ws.receive({ type: "ping" });
    expect(ws.sent.at(-1)).toEqual({ type: "pong" });
    ws.receive(MESSAGE);
    ws.receive({ type: "presence", conversationId: ID, online: true });
    expect(handlers.onFrame.mock.calls).toEqual([
      [MESSAGE],
      [{ type: "presence", conversationId: ID, online: true }],
    ]);
    // ready, ping and error stay the socket's own.
    ws.receive({ type: "error", code: "pong_timeout" });
    expect(handlers.onFrame).toHaveBeenCalledTimes(2);
  });

  it("speaks wss to an https API", async () => {
    const url = process.env.EXPO_PUBLIC_API_URL;
    process.env.EXPO_PUBLIC_API_URL = "https://api.kuutti.test/";
    try {
      stop = connect(handlers);
      expect(FakeWebSocket.latest().url).toBe("wss://api.kuutti.test/ws");
    } finally {
      if (url === undefined) delete process.env.EXPO_PUBLIC_API_URL;
      else process.env.EXPO_PUBLIC_API_URL = url;
    }
  });

  it("names no more conversations in a resume than the contract takes", async () => {
    const many = Array.from({ length: 2001 }, (_, i) => ({ id: ID, seq: i }));
    stop = connect({ ...handlers, cursors: () => many });
    const ws = ready();
    expect((ws.sent.at(-1) as { conversations: unknown[] }).conversations).toHaveLength(2000);
  });

  it("hands on a photo's message with a description key this build cannot say left out (#350)", async () => {
    const description = {
      people: 1,
      setting: "outdoors",
      scene: ["lake"],
      objects: ["dog"],
      smile: true,
      glasses: false,
      sunglasses: false,
      facialHair: false,
    };
    const photo = {
      photoId: "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01",
      blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
      width: 1600,
      height: 1067,
      urls: null,
    };
    stop = connect(handlers);
    const ws = ready();
    ws.receive({
      ...MESSAGE,
      message: {
        ...MESSAGE.message,
        kind: "photo",
        body: null,
        photo: { ...photo, description: { ...description, scene: ["lake", "volcano"] } },
      },
    });
    expect(handlers.onFrame.mock.calls).toEqual([
      [
        {
          ...MESSAGE,
          message: {
            ...MESSAGE.message,
            kind: "photo",
            body: null,
            photo: { ...photo, description },
          },
        },
      ],
    ]);
  });

  it("drops a frame outside the contract, and one that is not JSON, without a word", async () => {
    const log = jest.spyOn(console, "log");
    const warn = jest.spyOn(console, "warn");
    stop = connect(handlers);
    const ws = ready();
    ws.receive({ type: "message", conversationId: ID, message: { body: "secret" } });
    ws.receive({ type: "shout", text: "secret" });
    ws.receiveRaw("not json: secret");
    ws.receiveRaw(undefined);
    ws.receiveRaw("null");
    expect(handlers.onFrame).not.toHaveBeenCalled();
    expect([...log.mock.calls, ...warn.mock.calls]).toEqual([]);
    expect(ws.sent).toHaveLength(2);
  });

  it("reconnects after 1 s, doubling to 30 s, and from 1 s again after a ready", async () => {
    stop = connect(handlers);
    for (const wait of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
      const before = sockets();
      FakeWebSocket.latest().drop();
      await advance(wait - 1);
      expect(sockets()).toBe(before);
      await advance(1);
      expect(sockets()).toBe(before + 1);
    }
    ready().drop(1012);
    await advance(1000);
    expect(sockets()).toBe(9);
  });

  it("spreads each wait over its second half, so the phones a restart closed do not all come back at once", async () => {
    stop = connect({ ...handlers, random: () => 0 });
    ready().drop();
    await advance(499);
    expect(sockets()).toBe(1);
    await advance(1);
    expect(sockets()).toBe(2);
  });

  it("waits to be brought to the front again after the person's own sixth app pushed it out", async () => {
    stop = connect(handlers);
    const ws = ready();
    ws.receive({ type: "error", code: "too_many_sockets" });
    ws.drop(1008);
    expect(handlers.onStatus).toHaveBeenLastCalledWith("lost");
    await advance(60_000);
    expect(sockets()).toBe(1);
  });

  it("says lost when an open socket closes, or after the second try in a row fails, and open again on ready", async () => {
    stop = connect(handlers);
    FakeWebSocket.latest().drop();
    expect(handlers.onStatus).not.toHaveBeenCalled();
    await advance(1000);
    FakeWebSocket.latest().drop();
    expect(handlers.onStatus).toHaveBeenLastCalledWith("lost");
    await advance(2000);
    ready();
    expect(handlers.onStatus).toHaveBeenLastCalledWith("open");
    // Once it was open, a single close is lost.
    FakeWebSocket.latest().drop();
    expect(handlers.onStatus).toHaveBeenLastCalledWith("lost");
    await advance(1000);
    ready();
    // After the ready the count starts again: one failure is not lost yet.
    handlers.onStatus.mockClear();
    stop();
    stop = connect(handlers);
    FakeWebSocket.latest().drop();
    expect(handlers.onStatus).not.toHaveBeenCalled();
  });

  it("refreshes once after the API refused the token, connects with the new one, and stops when the refresh signs the device out", async () => {
    const asked = refreshes(
      () => json(tokens("2")),
      () => json({ error: { code: "unauthenticated", message: "x", requestId: "r" } }, 401),
    );
    stop = connect(handlers);
    const first = ready();
    first.receive({ type: "error", code: "session_expired" });
    first.drop(1008);
    await advance(1000);
    expect(asked()).toBe(1);
    const second = FakeWebSocket.latest();
    second.open();
    expect(second.sent).toEqual([{ type: "auth", token: token("access2") }]);
    second.receive({ type: "error", code: "session_revoked" });
    second.drop(1008);
    await advance(2000);
    expect(asked()).toBe(2);
    expect(currentSession()).toBeNull();
    await advance(60_000);
    expect(sockets()).toBe(2);
  });

  it("tries again later when the refresh cannot reach the API, and refreshes then", async () => {
    const asked = refreshes(
      () => {
        throw new TypeError("Network request failed");
      },
      () => json(tokens("2")),
    );
    stop = connect(handlers);
    const first = FakeWebSocket.latest();
    first.open();
    first.receive({ type: "error", code: "unauthenticated" });
    first.drop(1008);
    await advance(1000);
    expect(asked()).toBe(1);
    expect(sockets()).toBe(1);
    await advance(2000);
    expect(asked()).toBe(2);
    FakeWebSocket.latest().open();
    expect(FakeWebSocket.latest().sent).toEqual([{ type: "auth", token: token("access2") }]);
  });

  it("refreshes a token about to expire before it connects", async () => {
    await saveSession(tokens("1", 0.25));
    const asked = refreshes(() => json(tokens("2")));
    stop = connect(handlers);
    expect(sockets()).toBe(0);
    await advance(0);
    expect(asked()).toBe(1);
    FakeWebSocket.latest().open();
    expect(FakeWebSocket.latest().sent).toEqual([{ type: "auth", token: token("access2") }]);
  });

  it("tries again later when the socket cannot even be made", async () => {
    jest.spyOn(globalThis, "WebSocket", "get").mockReturnValue(function broken() {
      throw new SyntaxError("bad url");
    } as unknown as typeof WebSocket);
    stop = connect(handlers);
    expect(sockets()).toBe(0);
    FakeWebSocket.install();
    await advance(1000);
    expect(sockets()).toBe(1);
  });

  it("refreshes a minute ahead of expiry while open, again for the next token, and leaves it when the expiry did not move", async () => {
    const asked = refreshes(
      () => json(tokens("2", 30)),
      () => new Response("unwell", { status: 503 }),
    );
    stop = connect(handlers);
    ready();
    await advance(14 * 60_000 - 1);
    expect(asked()).toBe(0);
    await advance(1);
    expect(asked()).toBe(1);
    expect(currentSession()?.accessToken).toBe(token("access2"));
    // The next one is due a minute before 12:30; the API is unwell then.
    await advance(15 * 60_000);
    expect(asked()).toBe(2);
    await advance(60 * 60_000);
    expect(asked()).toBe(2);
  });

  it("refreshes ahead once, not again at once, when the new token is already due: a phone whose clock runs ahead", async () => {
    // The API's fifteen minutes end within the minute's lead on this clock.
    const asked = refreshes(
      () => json(tokens("2", 14.5)),
      () => json(tokens("3", 14.6)),
    );
    stop = connect(handlers);
    ready();
    await advance(14 * 60_000);
    expect(asked()).toBe(1);
    await advance(60_000);
    expect(asked()).toBe(1);
  });

  it("leaves an ahead-of-time refresh that cannot reach the API to the reconnect's own", async () => {
    const asked = refreshes(() => {
      throw new TypeError("Network request failed");
    });
    stop = connect(handlers);
    const ws = ready();
    await advance(14 * 60_000);
    expect(asked()).toBe(1);
    await advance(60 * 60_000);
    expect(asked()).toBe(1);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it("waits again when someone else refreshed first, and keeps no timer once closed", async () => {
    const asked = refreshes(() => json(tokens("3", 45)));
    stop = connect(handlers);
    const ws = ready();
    // An HTTP call refreshed meanwhile: the timer finds a later expiry and waits for it.
    await saveSession(tokens("2", 30));
    await advance(14 * 60_000);
    expect(asked()).toBe(0);
    await advance(15 * 60_000);
    expect(asked()).toBe(1);
    ws.drop();
    await advance(1000);
    // The new socket is not ready: nothing is refreshed ahead for it.
    await advance(60 * 60_000);
    expect(asked()).toBe(1);
  });

  it("stops refreshing ahead once signed out or stopped", async () => {
    const asked = refreshes(() => json(tokens("2")));
    stop = connect(handlers);
    ready();
    await clearSession();
    await advance(14 * 60_000);
    expect(asked()).toBe(0);
    await saveSession(tokens("1"));
    stop();
    stop = undefined;
    await advance(60 * 60_000);
    expect(asked()).toBe(0);
  });

  it("makes no socket without a session", async () => {
    await clearSession();
    stop = connect(handlers);
    await advance(60_000);
    expect(sockets()).toBe(0);
  });

  it("closes when stopped, and nothing comes after: no frame, no reconnect, no socket from a refresh under way", async () => {
    stop = connect(handlers);
    const ws = ready();
    handlers.onStatus.mockClear();
    stop();
    expect(ws.close).toHaveBeenCalled();
    ws.receive(MESSAGE);
    await advance(60_000);
    expect(handlers.onFrame).not.toHaveBeenCalled();
    expect(handlers.onStatus).not.toHaveBeenCalled();
    expect(sockets()).toBe(1);

    let answer: (response: Response) => void = () => undefined;
    refreshes(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    await saveSession(tokens("1", 0.25));
    stop = connect(handlers);
    stop();
    answer(json(tokens("2")));
    await advance(60_000);
    expect(sockets()).toBe(1);

    // Nor from a refresh under way that fails after the stop.
    refreshes(() => {
      throw new TypeError("Network request failed");
    });
    await saveSession(tokens("1", -1));
    stop = connect(handlers);
    stop();
    await advance(60_000);
    expect(sockets()).toBe(1);
    expect(handlers.onStatus).not.toHaveBeenCalled();

    // A stop while waiting to reconnect: the wait ends with nothing.
    await saveSession(tokens("1"));
    stop = connect(handlers);
    FakeWebSocket.latest().drop();
    stop();
    await advance(60_000);
    expect(sockets()).toBe(2);
  });
});
