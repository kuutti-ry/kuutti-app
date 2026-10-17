import { EventEmitter } from "node:events";
import type { Pool } from "@kuutti/db";
import { describe, expect, it, vi } from "vitest";
import { captureLogger, testPool } from "../test/harness.ts";
import { startChatListener } from "./listen.ts";
import { createLive, type Schedule } from "./live.ts";

// The listener's own life (#349): a connection refused and tried again, the
// notifications handed on in order, a lost connection closing every socket,
// whether it is listening, and the stop, one that comes first included. A stand-in for the pool's connection; live.test.ts runs the
// real one against Postgres.

class FakeClient extends EventEmitter {
  queries: string[] = [];
  released: boolean[] = [];
  failListen = false;
  async query(text: string) {
    this.queries.push(text);
    if (this.failListen && text.startsWith("LISTEN")) throw new Error("listen refused");
    return { rows: [] };
  }
  release(destroy?: boolean) {
    this.released.push(destroy === true);
  }
}

function manual() {
  const tasks: Array<{ ms: number; task: () => void }> = [];
  const schedule: Schedule = (ms, task) => {
    tasks.push({ ms, task });
    return () => undefined;
  };
  return { schedule, tasks };
}

async function setup(connects: Array<() => Promise<FakeClient>>) {
  const { logger, lines } = await captureLogger();
  const timers = manual();
  const live = createLive({
    db: testPool(),
    logger,
    socketsPerAccount: 5,
    schedule: timers.schedule,
  });
  const closed: string[] = [];
  live.presence.add({
    accountId: "a",
    sessionId: "s",
    hidden: false,
    send: () => undefined,
    close: (_code, error) => closed.push(error),
  });
  let n = 0;
  const pool = {
    connect: () => {
      const next = connects[Math.min(n, connects.length - 1)];
      n += 1;
      return next ? next() : Promise.reject(new Error("no client"));
    },
  } as unknown as Pool;
  return { logger, lines, timers, live, closed, pool };
}

describe("the chat listener", () => {
  it("tries again after a refused connection, with a doubling wait, and listens once it has one", async () => {
    const client = new FakeClient();
    const { lines, timers, live, pool, logger } = await setup([
      () => Promise.reject(new Error("refused")),
      () => Promise.resolve(client),
    ]);
    const listener = startChatListener({ pool, logger, live });
    await vi.waitUntil(() => timers.tasks.length === 1);
    expect(timers.tasks[0]?.ms).toBe(1_000);
    timers.tasks[0]?.task();
    await listener.ready;
    expect(client.queries).toEqual(["LISTEN kuutti_chat"]);
    expect(lines().map((l) => l.msg)).toEqual(
      expect.arrayContaining(["chat listener could not connect", "chat listener on"]),
    );
    await listener.stop();
    expect(client.queries.at(-1)).toBe("UNLISTEN kuutti_chat");
    expect(client.released).toEqual([true]);
  });

  it("hands each notification on in order, ignores other channels, and closes every socket when the connection is lost", async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const { timers, live, pool, logger, closed, lines } = await setup([
      () => Promise.resolve(first),
      () => Promise.resolve(second),
    ]);
    const delivered: string[] = [];
    live.hub.deliver = async (payload: string) => {
      delivered.push(payload);
    };
    const listener = startChatListener({ pool, logger, live });
    expect(live.listening).toBe(false);
    await listener.ready;
    expect(live.listening).toBe(true);
    first.emit("notification", { channel: "kuutti_chat", payload: "one" });
    first.emit("notification", { channel: "other", payload: "x" });
    first.emit("notification", { channel: "kuutti_chat", payload: "" });
    first.emit("notification", { channel: "kuutti_chat", payload: "two" });
    await vi.waitUntil(() => delivered.length === 2);
    expect(delivered).toEqual(["one", "two"]);
    // Lost: every socket hears restarting, a second report of the same loss changes nothing.
    first.emit("error", new Error("terminated"));
    first.emit("end");
    expect(closed).toEqual(["restarting"]);
    expect(live.listening).toBe(false);
    expect(first.released).toEqual([true]);
    expect(lines().filter((l) => l.msg === "chat listener lost")).toHaveLength(1);
    timers.tasks.at(-1)?.task();
    await vi.waitUntil(() => live.listening);
    expect(second.queries).toEqual(["LISTEN kuutti_chat"]);
    await listener.stop();
    expect(live.listening).toBe(false);
  });

  it("gives back a connection that arrives after the stop, and listens on nothing", async () => {
    const late = new FakeClient();
    let arrive: (client: FakeClient) => void = () => undefined;
    const { live, pool, logger } = await setup([
      () =>
        new Promise<FakeClient>((resolve) => {
          arrive = resolve;
        }),
    ]);
    const listener = startChatListener({ pool, logger, live });
    await listener.stop();
    arrive(late);
    await vi.waitUntil(() => late.released.length === 1);
    expect(late.released).toEqual([true]);
    expect(late.queries).toEqual([]);
    expect(live.listening).toBe(false);
  });

  it("treats a refused LISTEN as a lost connection, and a failed delivery as a logged one", async () => {
    const refusing = new FakeClient();
    refusing.failListen = true;
    const good = new FakeClient();
    const { timers, live, pool, logger, lines } = await setup([
      () => Promise.resolve(refusing),
      () => Promise.resolve(good),
    ]);
    live.hub.deliver = async () => {
      throw new Error("delivery failed");
    };
    const listener = startChatListener({ pool, logger, live });
    await vi.waitUntil(() => timers.tasks.length === 1);
    timers.tasks[0]?.task();
    await listener.ready;
    good.emit("notification", { channel: "kuutti_chat", payload: "x" });
    await vi.waitUntil(() => lines().some((l) => l.msg === "chat notification failed"));
    await listener.stop();
    // After the stop, a loss schedules nothing more.
    const before = timers.tasks.length;
    good.emit("end");
    expect(timers.tasks.length).toBe(before);
  });
});
