import type { Queryable } from "@kuutti/db";
import type { ServerFrame } from "@kuutti/schema";
import type { WSContext } from "hono/ws";
import { describe, expect, it, vi } from "vitest";
import type { SessionLookup, SessionStanding } from "../lib/auth-middleware.ts";
import { captureLogger } from "../test/harness.ts";
import { createLive, type Schedule } from "./live.ts";
import { socketEvents } from "./ws.ts";

// One socket's life against interleavings a real connection cannot pin down
// (#349): a second auth while the first is looked up, a phone gone while its
// session is touched or asked once more, the listener lost meanwhile, frames
// still arriving after a refusal, and a shadow ban the ping finds. The
// session store's calls are gates the test opens; the hub's announcements
// are recorded. live.test.ts runs the same code on a real server.

const ACCOUNT = "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a70";
const SESSION = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const TOKEN = "A".repeat(43);
const AT = new Date("2026-10-17T12:00:00.000Z");
const TIMING = { authMs: 5_000, pingMs: 30_000, pongMs: 10_000 };
const LIVE: SessionStanding = { standing: "live", shadowBanned: false };

/** A call the test answers when it chooses. */
function gate<T>() {
  const waiting: Array<(value: T) => void> = [];
  return {
    fn: vi.fn(() => new Promise<T>((resolve) => waiting.push(resolve))),
    open(value: T) {
      const next = waiting.shift();
      if (!next) throw new Error("nothing waits at this gate");
      next(value);
    },
  };
}

/** Lets every settled promise run on: the fakes do no I/O, so this is all there is to wait for. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function harness(options: { listening?: boolean } = {}) {
  const lookup = gate<SessionLookup | null>();
  const touch = gate<void>();
  const standing = gate<SessionStanding>();
  const timers = new Map<number, Array<() => void>>();
  const schedule: Schedule = (ms, task) => {
    const list = timers.get(ms) ?? [];
    list.push(task);
    timers.set(ms, list);
    return () => {
      const at = list.indexOf(task);
      if (at >= 0) list.splice(at, 1);
    };
  };
  const { logger, lines } = await captureLogger();
  // Nothing here reads the database itself: the store and the hub stand in.
  const db: Queryable = {
    query: () => Promise.reject(new Error("the socket asked the database directly")),
  } as unknown as Queryable;
  const live = createLive({ db, logger, socketsPerAccount: 5, schedule });
  live.listening = options.listening ?? true;
  const announced = vi.spyOn(live.hub, "announcePresence").mockResolvedValue();
  const frames: ServerFrame[] = [];
  let closed: { code: number; reason: string } | null = null;
  const ws = {
    get readyState() {
      return closed ? 3 : 1;
    },
    send: (data: string) => frames.push(JSON.parse(data) as ServerFrame),
    close: (code: number, reason: string) => {
      closed = { code, reason };
    },
  } as unknown as WSContext;
  const events = socketEvents(
    {
      db,
      logger,
      store: { findByAccessHash: lookup.fn, touch: touch.fn, standing: standing.fn },
      live,
      now: () => AT,
      allowedOrigins: new Set(),
      timing: TIMING,
    },
    "request-1",
  );
  events.onOpen?.(new Event("open"), ws);
  return {
    live,
    logged: () => lines().map((l) => l.msg),
    lookup,
    touch,
    standing,
    announced,
    frames,
    closed: () => closed,
    send: (frame: unknown) =>
      events.onMessage?.({ data: JSON.stringify(frame) } as MessageEvent, ws),
    /** The phone vanished: ws says the socket closed. */
    vanish: () => events.onClose?.({ code: 1006 } as CloseEvent, ws),
    /** Runs the timers of that length, once: each is gone once it has run, as a real one is. */
    run: async (ms: number) => {
      for (const task of (timers.get(ms) ?? []).splice(0)) task();
      await settle();
    },
    pending: (ms: number) => timers.get(ms)?.length ?? 0,
  };
}

const found = (over: Partial<SessionLookup> = {}): SessionLookup => ({
  accountId: ACCOUNT,
  sessionId: SESSION,
  accessExpiresAt: new Date(AT.getTime() + 60_000),
  revokedAt: null,
  accountState: "active",
  identityStanding: "ok",
  ...over,
});

/** Through the lookup, the touch and the second ask: ready, and announced. */
async function signedIn(h: Awaited<ReturnType<typeof harness>>) {
  h.send({ type: "auth", token: TOKEN });
  await settle();
  h.lookup.open(found());
  await settle();
  h.touch.open();
  await settle();
  h.standing.open(LIVE);
  await settle();
  expect(h.frames).toEqual([{ type: "ready" }]);
}

describe("one socket's life, interleaved", () => {
  it("refuses a second auth unread while the first is looked up, and the first then registers nothing", async () => {
    const h = await harness();
    h.send({ type: "auth", token: TOKEN });
    h.send({ type: "auth", token: TOKEN });
    expect(h.frames).toEqual([{ type: "error", code: "bad_frame" }]);
    expect(h.closed()).toEqual({ code: 1008, reason: "bad_frame" });
    h.lookup.open(found());
    await settle();
    expect(h.lookup.fn).toHaveBeenCalledTimes(1);
    expect(h.touch.fn).not.toHaveBeenCalled();
    expect(h.live.presence.socketsOf(ACCOUNT)).toEqual([]);
    expect(h.announced).not.toHaveBeenCalled();
  });

  it("reads no frame after a refusal, an auth included", async () => {
    const h = await harness();
    h.send("not a frame");
    expect(h.closed()?.reason).toBe("bad_frame");
    h.send({ type: "auth", token: TOKEN });
    await settle();
    expect(h.lookup.fn).not.toHaveBeenCalled();
    expect(h.frames).toEqual([{ type: "error", code: "bad_frame" }]);
  });

  it("registers nothing for a phone gone while its session is touched, and keeps no timer", async () => {
    const h = await harness();
    h.send({ type: "auth", token: TOKEN });
    await settle();
    h.lookup.open(found());
    await settle();
    h.vanish();
    h.touch.open();
    await settle();
    expect(h.live.presence.socketsOf(ACCOUNT)).toEqual([]);
    expect(h.standing.fn).not.toHaveBeenCalled();
    expect(h.frames).toEqual([]);
    expect(h.announced).not.toHaveBeenCalled();
    expect([h.pending(TIMING.authMs), h.pending(TIMING.pingMs)]).toEqual([0, 0]);
  });

  it("announces a phone gone while its session is asked once more as offline, and never as online after", async () => {
    const h = await harness();
    h.send({ type: "auth", token: TOKEN });
    await settle();
    h.lookup.open(found());
    await settle();
    h.touch.open();
    await settle();
    expect(h.live.presence.online(ACCOUNT)).toBe(true);
    h.vanish();
    await settle();
    expect(h.announced).toHaveBeenCalledTimes(1);
    h.standing.open(LIVE);
    await settle();
    expect(h.announced).toHaveBeenCalledTimes(1);
    expect(h.live.presence.online(ACCOUNT)).toBe(false);
    expect(h.frames).toEqual([]);
    expect(h.pending(TIMING.pingMs)).toBe(0);
  });

  it("refuses with restarting while the listener is down, before the token is looked up", async () => {
    const h = await harness({ listening: false });
    h.send({ type: "auth", token: TOKEN });
    await settle();
    expect(h.frames).toEqual([{ type: "error", code: "restarting" }]);
    expect(h.closed()).toEqual({ code: 1012, reason: "restarting" });
    expect(h.lookup.fn).not.toHaveBeenCalled();
  });

  it("refuses with restarting when the listener was lost while the token was looked up", async () => {
    const h = await harness();
    h.send({ type: "auth", token: TOKEN });
    await settle();
    h.lookup.open(found());
    await settle();
    // What listen.ts does when its connection goes: every socket it knew closed.
    h.live.listening = false;
    h.live.closeAll(1012, "restarting");
    h.touch.open();
    await settle();
    expect(h.frames).toEqual([{ type: "error", code: "restarting" }]);
    expect(h.closed()?.code).toBe(1012);
    expect(h.live.presence.socketsOf(ACCOUNT)).toEqual([]);
  });

  it("hides the account at a ping that finds a shadow ban, tells the counterparts, and shows it again when the ban is lifted", async () => {
    const h = await harness();
    await signedIn(h);
    expect(h.announced).toHaveBeenCalledTimes(1);
    await h.run(TIMING.pingMs);
    h.standing.open({ standing: "live", shadowBanned: true });
    await settle();
    expect(h.frames.at(-1)).toEqual({ type: "ping" });
    expect(h.live.presence.online(ACCOUNT)).toBe(false);
    expect(h.announced).toHaveBeenCalledTimes(2);
    h.send({ type: "pong" });
    // The same answer again changes nothing.
    await h.run(TIMING.pingMs);
    h.standing.open({ standing: "live", shadowBanned: true });
    await settle();
    expect(h.announced).toHaveBeenCalledTimes(2);
    h.send({ type: "pong" });
    await h.run(TIMING.pingMs);
    h.standing.open(LIVE);
    await settle();
    expect(h.live.presence.online(ACCOUNT)).toBe(true);
    expect(h.announced).toHaveBeenCalledTimes(3);
    expect(h.announced).toHaveBeenLastCalledWith(ACCOUNT);
  });

  it("refuses a session found ended when asked once more after the registration, and takes it out when the phone goes", async () => {
    const h = await harness();
    h.send({ type: "auth", token: TOKEN });
    await settle();
    h.lookup.open(found());
    await settle();
    h.touch.open();
    await settle();
    h.standing.open({ standing: "ended", shadowBanned: false });
    await settle();
    expect(h.frames).toEqual([{ type: "error", code: "session_revoked" }]);
    expect(h.closed()).toEqual({ code: 1008, reason: "session_revoked" });
    h.vanish();
    await settle();
    expect(h.live.presence.socketsOf(ACCOUNT)).toEqual([]);
    expect(h.live.presence.online(ACCOUNT)).toBe(false);
  });

  it("asks again at the next ping when the ask fails, and closes a session the ping finds ended", async () => {
    const h = await harness();
    await signedIn(h);
    h.standing.fn.mockRejectedValueOnce(new Error("the pool had no connection"));
    await h.run(TIMING.pingMs);
    expect(h.logged()).toContain("chat socket ping failed");
    expect(h.frames).toEqual([{ type: "ready" }]);
    expect(h.pending(TIMING.pingMs)).toBe(1);
    await h.run(TIMING.pingMs);
    h.standing.open({ standing: "ended", shadowBanned: false });
    await settle();
    expect(h.frames.at(-1)).toEqual({ type: "error", code: "session_revoked" });
    expect(h.closed()).toEqual({ code: 1008, reason: "session_revoked" });
  });

  it("closes with internal_error when a frame's work fails, and logs a close whose work fails", async () => {
    const h = await harness();
    h.lookup.fn.mockRejectedValueOnce(new Error("the pool had no connection"));
    h.send({ type: "auth", token: TOKEN });
    await settle();
    expect(h.frames).toEqual([{ type: "error", code: "internal_error" }]);
    expect(h.closed()).toEqual({ code: 1011, reason: "internal_error" });
    expect(h.logged()).toContain("chat socket frame failed");
    const other = await harness();
    await signedIn(other);
    other.announced.mockRejectedValueOnce(new Error("the pool had no connection"));
    other.vanish();
    await settle();
    expect(other.logged()).toContain("chat socket close failed");
  });

  it("stops at a ping whose answer comes after the phone is gone", async () => {
    const h = await harness();
    await signedIn(h);
    await h.run(TIMING.pingMs);
    h.vanish();
    await settle();
    h.standing.open({ standing: "live", shadowBanned: true });
    await settle();
    expect(h.frames).toEqual([{ type: "ready" }]);
    expect([h.pending(TIMING.pingMs), h.pending(TIMING.pongMs)]).toEqual([0, 0]);
  });
});
