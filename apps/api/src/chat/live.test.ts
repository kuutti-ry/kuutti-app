import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createPool, migrate, type Pool, withTemporaryDatabase } from "@kuutti/db";
import { FRAME_BYTES_MAX, MESSAGES_PAGE_MAX, ServerFrame } from "@kuutti/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createApp } from "../app.ts";
import { eraseAccount } from "../identity/index.ts";
import { createLogger, type Logger } from "../lib/logger.ts";
import { applySanction } from "../safety/index.ts";
import { signedInAccount, staffSession } from "../test/account.ts";
import { cardShown } from "../test/cards.ts";
import { conversationBetween } from "../test/chat.ts";
import { testConfig } from "../test/harness.ts";
import { archiveSilentConversations } from "./archive.ts";
import { startChatListener } from "./listen.ts";
import { createLive, type Live, type Schedule } from "./live.ts";

// features/chat/live.feature (#349, ADR-031 §5): the socket on a real
// server over a database of its own, the listener on Postgres's channel, `ws`
// clients. Committed rows, since a notification arrives only on commit.
// Nothing sleeps: a frame is awaited as an event, the socket's timers are a
// scheduler the test runs by hand, and "nothing more arrived" is shown by a
// later frame that the same ordered delivery brings after it.

const MIGRATIONS = resolve(import.meta.dirname, "../../../../packages/db/drizzle");
// A marker of letters: a number can turn up in a timestamp by chance.
const MARK = "qzxvkw";
const AUTH_MS = 5_000;
const PING_MS = 30_000;
const PONG_MS = 10_000;

/** The socket's timers, run when the test says so, by their length. */
function manualSchedule() {
  const tasks = new Set<{ ms: number; task: () => void }>();
  const cancelWaiters: Array<{ ms: number; resolve: () => void }> = [];
  const schedule: Schedule = (ms, task) => {
    const entry = { ms, task };
    tasks.add(entry);
    return () => {
      if (!tasks.delete(entry)) return;
      for (const waiter of cancelWaiters.filter((w) => w.ms === ms)) {
        cancelWaiters.splice(cancelWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    };
  };
  return {
    schedule,
    /** Runs every pending task of that length, once. */
    run(ms: number) {
      const due = [...tasks].filter((t) => t.ms === ms);
      for (const entry of due) {
        tasks.delete(entry);
        entry.task();
      }
      return due.length;
    },
    /** Resolves when a pending task of that length is cancelled: the server acted on what it was sent. */
    cancelled: (ms: number) => new Promise<void>((resolve) => cancelWaiters.push({ ms, resolve })),
  };
}

/** A logger whose lines can be awaited, with production redaction. */
async function watchedLogger() {
  const raw: string[] = [];
  const waiters: Array<{ msg: string; resolve: () => void }> = [];
  const logger = await createLogger({
    level: "trace",
    pretty: false,
    destination: {
      write: (line: string) => {
        raw.push(line);
        const msg = (JSON.parse(line) as { msg?: string }).msg;
        for (const waiter of waiters.filter((w) => w.msg === msg)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      },
    },
  });
  return {
    logger,
    text: () => raw.join("\n"),
    next: (msg: string) => new Promise<void>((resolve) => waiters.push({ msg, resolve })),
  };
}

type Ctx = {
  pool: Pool;
  url: string;
  app: ReturnType<typeof createApp>;
  live: Live;
  timers: ReturnType<typeof manualSchedule>;
  log: Awaited<ReturnType<typeof watchedLogger>>;
  logger: Logger;
  listener: ReturnType<typeof startChatListener>;
};

let ctx: Ctx;
let release: () => void = () => {};
let finished: Promise<unknown>;

beforeAll(async () => {
  await new Promise<void>((ready, fail) => {
    finished = withTemporaryDatabase(async (database) => {
      const pool = createPool({
        connectionString: database,
        max: 8,
        applicationName: "kuutti-live",
      });
      const wss = new WebSocketServer({ noServer: true, maxPayload: FRAME_BYTES_MAX });
      const log = await watchedLogger();
      const timers = manualSchedule();
      try {
        await migrate(pool, MIGRATIONS);
        const live = createLive({
          db: pool,
          logger: log.logger,
          socketsPerAccount: 5,
          schedule: timers.schedule,
        });
        const app = createApp({ config: testConfig(), logger: log.logger, db: pool, live });
        const server = serve({
          fetch: app.fetch,
          port: 0,
          hostname: "127.0.0.1",
          websocket: { server: wss },
        });
        await new Promise<void>((up) => server.once("listening", () => up()));
        const port = (server.address() as AddressInfo).port;
        const listener = startChatListener({ pool, logger: log.logger, live });
        await listener.ready;
        ctx = {
          pool,
          url: `ws://127.0.0.1:${port}/ws`,
          app,
          live,
          timers,
          log,
          logger: log.logger,
          listener,
        };
        ready();
        await new Promise<void>((done) => {
          release = done;
        });
        for (const client of wss.clients) client.terminate();
        await new Promise<void>((closed) => server.close(() => closed()));
        await listener.stop();
      } catch (error) {
        fail(error);
      } finally {
        await pool.end();
      }
    });
  });
}, 60_000);

afterAll(async () => {
  release();
  await finished;
});

type Phone = {
  frames: ServerFrame[];
  send: (frame: unknown) => void;
  /** The next frame matching, received from now on or already waiting unread. */
  next: (match: (frame: ServerFrame) => boolean) => Promise<ServerFrame>;
  closed: Promise<{ code: number; reason: string }>;
  close: () => void;
};

/** A phone's socket: frames recorded, each checked against the contract. */
function phone(options: { origin?: string } = {}): Promise<Phone> {
  const socket = new WebSocket(ctx.url, options.origin ? { origin: options.origin } : {});
  const frames: ServerFrame[] = [];
  let read = 0;
  const waiters: Array<{ match: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }> =
    [];
  const take = () => {
    for (const waiter of [...waiters]) {
      const at = frames.findIndex((f, i) => i >= read && waiter.match(f));
      if (at >= 0) {
        read = at + 1;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frames[at] as ServerFrame);
      }
    }
  };
  socket.on("message", (data) => {
    frames.push(ServerFrame.parse(JSON.parse(String(data))));
    take();
  });
  const closed = new Promise<{ code: number; reason: string }>((done) =>
    socket.on("close", (code, reason) => done({ code, reason: String(reason) })),
  );
  return new Promise((ready, fail) => {
    socket.once("open", () =>
      ready({
        frames,
        send: (frame) =>
          socket.send(
            typeof frame === "string" || Buffer.isBuffer(frame) ? frame : JSON.stringify(frame),
          ),
        next: (match) =>
          new Promise((resolve) => {
            waiters.push({ match, resolve });
            take();
          }),
        closed,
        close: () => socket.close(1000),
      }),
    );
    socket.once("unexpected-response", (_req, res) => fail(new Error(`upgrade ${res.statusCode}`)));
    socket.once("error", fail);
  });
}

/** A phone past its first frame: authenticated and `ready`, its resume not yet sent. */
async function authed(token: string) {
  const p = await phone();
  p.send({ type: "auth", token });
  await p.next((f) => f.type === "ready");
  return p;
}

/** A signed-in phone: authenticated, `ready`, and resumed on these conversations. */
async function signedIn(token: string, resume: Array<{ id: string; seq: number }> = []) {
  const p = await authed(token);
  p.send({ type: "resume", conversations: resume });
  for (const { id } of resume) {
    await p.next((f) => f.type === "conversation" && f.conversationId === id);
  }
  return p;
}

const json = (headers: Record<string, string>) => ({
  ...headers,
  "content-type": "application/json",
});
const send = (headers: Record<string, string>, id: string, body: string, clientId = randomUUID()) =>
  ctx.app.request(`/conversations/${id}/messages`, {
    method: "POST",
    headers: json(headers),
    body: JSON.stringify({ clientId, body }),
  });
const markRead = (headers: Record<string, string>, id: string, upTo: number) =>
  ctx.app.request(`/conversations/${id}/read`, {
    method: "POST",
    headers: json(headers),
    body: JSON.stringify({ upTo }),
  });

async function pair() {
  const a = await signedInAccount(ctx.pool);
  const b = await signedInAccount(ctx.pool);
  const id = await conversationBetween(ctx.pool, a.accountId, b.accountId);
  return { a, b, id };
}

const isMessage = (id: string, seq: number) => (f: ServerFrame) =>
  f.type === "message" && f.conversationId === id && f.message.seq === seq;

describe("the socket's door", () => {
  it("The first frame authenticates, and the socket says it is ready", async () => {
    const a = await signedInAccount(ctx.pool);
    const p = await phone();
    p.send({ type: "auth", token: a.accessToken });
    expect(await p.next((f) => f.type === "ready")).toEqual({ type: "ready" });
    p.close();
    await p.closed;
  });

  it("A socket that does not authenticate in time, or brings anything else first, is closed", async () => {
    // Silence: the deadline runs out.
    const silent = await phone();
    expect(ctx.timers.run(AUTH_MS)).toBeGreaterThanOrEqual(1);
    expect(await silent.next((f) => f.type === "error")).toEqual({
      type: "error",
      code: "auth_timeout",
    });
    expect((await silent.closed).code).toBe(1008);

    const a = await signedInAccount(ctx.pool);
    const staff = await staffSession(ctx.pool);
    const revoked = await signedInAccount(ctx.pool);
    await ctx.pool.query("UPDATE session SET revoked_at = now() WHERE id = $1", [
      revoked.sessionId,
    ]);
    const cases: Array<[unknown, string]> = [
      [{ type: "resume", conversations: [] }, "bad_frame"],
      [{ type: "pong" }, "bad_frame"],
      [{ type: "auth", token: "x".repeat(43) }, "unauthenticated"],
      [{ type: "auth", token: staff.accessToken }, "unauthenticated"],
      [{ type: "auth", token: revoked.accessToken }, "session_revoked"],
      [{ type: "auth", token: a.accessToken, extra: 1 }, "bad_frame"],
    ];
    for (const [frame, code] of cases) {
      const p = await phone();
      p.send(frame);
      expect(await p.next((f) => f.type === "error"), JSON.stringify(frame)).toEqual({
        type: "error",
        code,
      });
      expect((await p.closed).code).toBe(1008);
    }
  });

  it("A frame outside the contract closes the socket", async () => {
    const a = await signedInAccount(ctx.pool);
    const id = randomUUID();
    // Each the first frame after ready, a resume included.
    const outside: unknown[] = [
      "not json",
      { type: "typing" },
      { type: "auth", token: a.accessToken },
      { type: "resume", conversations: [{ id: "nope", seq: 0 }] },
      {
        type: "resume",
        conversations: [
          { id, seq: 0 },
          { id, seq: 1 },
        ],
      },
    ];
    for (const frame of outside) {
      const p = await authed(a.accessToken);
      p.send(frame);
      expect(await p.next((f) => f.type === "error")).toEqual({ type: "error", code: "bad_frame" });
      expect((await p.closed).code).toBe(1008);
    }
    // A binary frame is no frame of the contract either, nor a second resume.
    const binary = await signedIn(a.accessToken);
    binary.send(Buffer.from([1, 2, 3]));
    expect(await binary.next((f) => f.type === "error")).toEqual({
      type: "error",
      code: "bad_frame",
    });
    expect((await binary.closed).code).toBe(1008);
    const twice = await signedIn(a.accessToken);
    twice.send({ type: "resume", conversations: [] });
    expect(await twice.next((f) => f.type === "error")).toEqual({
      type: "error",
      code: "bad_frame",
    });
    expect((await twice.closed).code).toBe(1008);
    // A frame past the bound is cut before it is read.
    const big = await phone();
    big.send(JSON.stringify({ type: "auth", token: "x".repeat(FRAME_BYTES_MAX) }));
    expect((await big.closed).code).toBe(1009);
  });

  it("An upgrade from an origin the API does not admit is refused; its own host and an admitted one pass", async () => {
    await expect(phone({ origin: "https://elsewhere.example" })).rejects.toThrow("upgrade 403");
    await expect(phone({ origin: "not a url" })).rejects.toThrow("upgrade 403");
    const own = await phone({ origin: ctx.url.replace("ws://", "http://").replace("/ws", "") });
    own.close();
    const admitted = await phone({ origin: "http://localhost:8081" });
    admitted.close();
    // A plain GET is told this path speaks WebSocket.
    const plain = await ctx.app.request("/ws");
    expect(plain.status).toBe(426);
    expect(plain.headers.get("upgrade")).toBe("websocket");
  });
});

describe("what the socket carries", () => {
  it("A message reaches every socket of both people as it is committed", async () => {
    const { a, b, id } = await pair();
    const a1 = await signedIn(a.accessToken, [{ id, seq: 0 }]);
    const a2 = await signedIn(a.accessToken, [{ id, seq: 0 }]);
    const b1 = await signedIn(b.accessToken, [{ id, seq: 0 }]);
    const clientId = randomUUID();
    expect((await send(b.headers, id, "Hei!", clientId)).status).toBe(201);
    for (const p of [a1, a2]) {
      const frame = await p.next(isMessage(id, 1));
      expect(frame).toMatchObject({
        message: { side: "theirs", body: "Hei!", clientId: null },
      });
    }
    expect(await b1.next(isMessage(id, 1))).toMatchObject({
      message: { side: "mine", body: "Hei!", clientId },
    });
  });

  it("A resend writes one message and sends one frame", async () => {
    const { a, b, id } = await pair();
    const pa = await signedIn(a.accessToken, [{ id, seq: 0 }]);
    const clientId = randomUUID();
    expect((await send(b.headers, id, "Hei", clientId)).status).toBe(201);
    expect((await send(b.headers, id, "Hei", clientId)).status).toBe(200);
    // A later message, delivered in commit order after anything the resend might have sent.
    expect((await send(b.headers, id, "Moi")).status).toBe(201);
    await pa.next(isMessage(id, 2));
    expect(
      pa.frames
        .filter((f) => f.type === "message")
        .map((f) => f.type === "message" && f.message.seq),
    ).toEqual([1, 2]);
  });

  it("A message committed while the phone is away arrives once at the next resume", async () => {
    const { a, b, id } = await pair();
    const first = await signedIn(a.accessToken, [{ id, seq: 0 }]);
    expect((await send(b.headers, id, "Yksi")).status).toBe(201);
    await first.next(isMessage(id, 1));
    first.close();
    await first.closed;
    expect((await send(b.headers, id, "Kaksi")).status).toBe(201);
    expect((await send(b.headers, id, "Kolme")).status).toBe(201);
    const back = await phone();
    back.send({ type: "auth", token: a.accessToken });
    await back.next((f) => f.type === "ready");
    back.send({ type: "resume", conversations: [{ id, seq: 1 }] });
    await back.next((f) => f.type === "conversation" && f.conversationId === id);
    expect(back.frames.filter((f) => f.type !== "ready").map((f) => f.type)).toEqual([
      "message",
      "message",
      "read",
      "presence",
      "conversation",
    ]);
    expect(
      back.frames.flatMap((f) => (f.type === "message" ? [[f.message.seq, f.message.body]] : [])),
    ).toEqual([
      [2, "Kaksi"],
      [3, "Kolme"],
    ]);
    // Nobody else's conversation: a stranger's id answers gone.
    const stranger = await signedIn(a.accessToken, [{ id: randomUUID(), seq: 0 }]);
    expect(stranger.frames.at(-1)).toMatchObject({ type: "conversation", state: "gone" });
  });

  it("A resume before the list has loaded still hears who is online", async () => {
    const { a, b, id } = await pair();
    const pb = await signedIn(b.accessToken, [{ id, seq: 0 }]);
    const stranger = randomUUID();
    const first = await signedIn(a.accessToken, [{ id: stranger, seq: 0 }]);
    expect(first.frames).toEqual([
      { type: "ready" },
      { type: "presence", conversationId: id, online: true },
      { type: "conversation", conversationId: stranger, state: "gone", closedHow: null },
    ]);
    const second = await signedIn(a.accessToken, [{ id, seq: 0 }]);
    expect(second.frames.filter((f) => f.type === "presence")).toEqual([
      { type: "presence", conversationId: id, online: true },
    ]);
    for (const p of [pb, first, second]) p.close();
  });

  it("A resume far behind gets the oldest page it lacks, the rest left to HTTP", async () => {
    const a = await signedInAccount(ctx.pool);
    const b = await signedInAccount(ctx.pool);
    const id = await conversationBetween(ctx.pool, a.accountId, b.accountId, {
      messages: Array.from({ length: MESSAGES_PAGE_MAX + 1 }, (_, i) => ({
        from: "b" as const,
        body: `Viesti ${i + 1}`,
      })),
    });
    // Each row written notified the hub; a later message elsewhere, delivered
    // in the same order, says it is through them, so none reaches A's phone live.
    const x = await signedInAccount(ctx.pool);
    const y = await signedInAccount(ctx.pool);
    const elsewhere = await conversationBetween(ctx.pool, x.accountId, y.accountId);
    const px = await signedIn(x.accessToken, [{ id: elsewhere, seq: 0 }]);
    expect((await send(y.headers, elsewhere, "Valmis")).status).toBe(201);
    await px.next(isMessage(elsewhere, 1));
    const pa = await signedIn(a.accessToken, [{ id, seq: 0 }]);
    const seqs = pa.frames.flatMap((f) => (f.type === "message" ? [f.message.seq] : []));
    expect(seqs).toEqual(Array.from({ length: MESSAGES_PAGE_MAX }, (_, i) => i + 1));
    expect(pa.frames.slice(-3).map((f) => f.type)).toEqual(["read", "presence", "conversation"]);
    // Holding the newest, the resume sends no message at all.
    const current = await signedIn(a.accessToken, [{ id, seq: MESSAGES_PAGE_MAX + 1 }]);
    expect(current.frames.some((f) => f.type === "message")).toBe(false);
    for (const p of [pa, current, px]) p.close();
  });

  it("The other side's read mark reaches the writer", async () => {
    const { a, b, id } = await pair();
    const pa = await signedIn(a.accessToken, [{ id, seq: 0 }]);
    expect((await send(a.headers, id, "Hei")).status).toBe(201);
    expect((await markRead(b.headers, id, 1)).status).toBe(204);
    expect(await pa.next((f) => f.type === "read")).toEqual({
      type: "read",
      conversationId: id,
      upTo: 1,
    });
  });

  it("The counterpart shows online while a socket is open, and offline when the last one closes", async () => {
    const { a, b, id } = await pair();
    const pa = await signedIn(a.accessToken, [{ id, seq: 0 }]);
    expect(pa.frames).toContainEqual({ type: "presence", conversationId: id, online: false });
    const b1 = await signedIn(b.accessToken);
    expect(await pa.next((f) => f.type === "presence")).toEqual({
      type: "presence",
      conversationId: id,
      online: true,
    });
    // A second socket of B's says nothing; nor does its closing.
    const b2 = await signedIn(b.accessToken);
    b2.close();
    await b2.closed;
    b1.close();
    await b1.closed;
    expect(await pa.next((f) => f.type === "presence")).toEqual({
      type: "presence",
      conversationId: id,
      online: false,
    });
    expect(pa.frames.filter((f) => f.type === "presence")).toHaveLength(3);
  });

  it("The sixth socket of an account closes the oldest", async () => {
    const a = await signedInAccount(ctx.pool);
    const sockets = [];
    for (let i = 0; i < 5; i += 1) sockets.push(await signedIn(a.accessToken));
    const sixth = await signedIn(a.accessToken);
    expect(await sockets[0]?.next((f) => f.type === "error")).toEqual({
      type: "error",
      code: "too_many_sockets",
    });
    expect((await sockets[0]?.closed)?.code).toBe(1008);
    sixth.close();
  });
});

describe("what the socket withholds", () => {
  it("A block reaches both sides as a conversation frame, and nothing after it", async () => {
    const a = await signedInAccount(ctx.pool);
    const b = await signedInAccount(ctx.pool);
    // A message of B's, so A's read mark can move after the block.
    const id = await conversationBetween(ctx.pool, a.accountId, b.accountId, {
      messages: [{ from: "b", body: "Moi" }],
    });
    const pa = await signedIn(a.accessToken, [{ id, seq: 0 }]);
    const pb = await signedIn(b.accessToken, [{ id, seq: 0 }]);
    await cardShown(ctx.pool, b.accountId, a.accountId);
    const blocked = await ctx.app.request("/blocks", {
      method: "POST",
      headers: json(b.headers),
      body: JSON.stringify({ accountId: a.accountId }),
    });
    expect(blocked.status).toBe(204);
    expect(await pa.next((f) => f.type === "conversation")).toEqual({
      type: "conversation",
      conversationId: id,
      state: "closed",
      closedHow: "unmatch",
    });
    expect(await pb.next((f) => f.type === "conversation")).toEqual({
      type: "conversation",
      conversationId: id,
      state: "gone",
      closedHow: null,
    });
    const sinceBlock =
      pb.frames.findIndex((f) => f.type === "conversation" && f.state === "gone") + 1;
    // A's read mark moves (the trigger fires); B, gone from the conversation, hears nothing of it.
    expect((await send(a.headers, id, "Hei")).status).toBe(409);
    expect((await markRead(a.headers, id, 1)).status).toBe(204);
    const { rows } = await ctx.pool.query<{ read_up_to: number }>(
      "SELECT read_up_to FROM conversation_participant WHERE conversation_id = $1 AND account_id = $2",
      [id, a.accountId],
    );
    expect(rows[0]?.read_up_to).toBe(1);
    const other = await signedInAccount(ctx.pool);
    const later = await conversationBetween(ctx.pool, other.accountId, b.accountId);
    expect((await send(other.headers, later, "Tässä")).status).toBe(201);
    await pb.next(isMessage(later, 1));
    // Since the block, nothing of the conversation has reached B.
    expect(
      pb.frames.slice(sinceBlock).filter((f) => "conversationId" in f && f.conversationId === id),
    ).toEqual([]);
  });

  it("A shadow-banned sender's message reaches no counterpart, and the sender is never online", async () => {
    const { a, b, id } = await pair();
    await applySanction(ctx.pool, {
      accountId: a.accountId,
      kind: "shadow_ban",
      reason: "commercial_use",
      note: "Sends the same link to everybody.",
      actor: null,
      at: new Date(Date.now() - 1000),
    });
    const pb = await signedIn(b.accessToken, [{ id, seq: 0 }]);
    const pa = await signedIn(a.accessToken, [{ id, seq: 0 }]);
    expect((await send(a.headers, id, `Osta ${MARK}`)).status).toBe(201);
    expect(await pa.next(isMessage(id, 1))).toMatchObject({ message: { side: "mine" } });
    // A later frame for B, after which A's message would have come.
    const other = await signedInAccount(ctx.pool);
    const later = await conversationBetween(ctx.pool, other.accountId, b.accountId);
    expect((await send(other.headers, later, "Moi")).status).toBe(201);
    await pb.next(isMessage(later, 1));
    expect(pb.frames.some((f) => f.type === "message" && f.conversationId === id)).toBe(false);
    expect(pb.frames.filter((f) => f.type === "presence" && f.conversationId === id)).toEqual([
      { type: "presence", conversationId: id, online: false },
    ]);
  });

  it("A shadow ban put on while the socket is open hides the person at the next ping", async () => {
    const { a, b, id } = await pair();
    const pb = await signedIn(b.accessToken, [{ id, seq: 0 }]);
    const pa = await signedIn(a.accessToken, [{ id, seq: 0 }]);
    expect(await pb.next((f) => f.type === "presence")).toEqual({
      type: "presence",
      conversationId: id,
      online: true,
    });
    await applySanction(ctx.pool, {
      accountId: a.accountId,
      kind: "shadow_ban",
      reason: "commercial_use",
      note: "Sends the same link to everybody.",
      actor: null,
      at: new Date(Date.now() - 1000),
    });
    ctx.timers.run(PING_MS);
    expect(await pb.next((f) => f.type === "presence")).toEqual({
      type: "presence",
      conversationId: id,
      online: false,
    });
    // And a resume of B's says the same.
    const again = await signedIn(b.accessToken, [{ id, seq: 0 }]);
    expect(again.frames).toContainEqual({ type: "presence", conversationId: id, online: false });
    for (const p of [pa, pb, again]) p.close();
  });

  it("A session that ends closes its sockets at once", async () => {
    const a = await signedInAccount(ctx.pool);
    const b = await signedInAccount(ctx.pool);
    const pa = await signedIn(a.accessToken);
    const pb = await signedIn(b.accessToken);
    expect(
      (await ctx.app.request("/auth/logout", { method: "POST", headers: a.headers })).status,
    ).toBe(204);
    expect(await pa.next((f) => f.type === "error")).toEqual({
      type: "error",
      code: "session_revoked",
    });
    expect((await pa.closed).code).toBe(1008);
    // Erasure deletes the session: the same.
    await eraseAccount({ db: ctx.pool, logger: ctx.logger, now: () => new Date() }, b.accountId);
    expect(await pb.next((f) => f.type === "error")).toEqual({
      type: "error",
      code: "session_revoked",
    });
    expect((await pb.closed).code).toBe(1008);
  });

  it("Archive and erasure reach the other side as the conversation's state", async () => {
    const { a, b, id } = await pair();
    const pa = await signedIn(a.accessToken, [{ id, seq: 0 }]);
    await archiveSilentConversations({
      db: ctx.pool,
      logger: ctx.logger,
      now: () => new Date(Date.now() + 8 * 86_400_000),
    });
    expect(await pa.next((f) => f.type === "conversation")).toEqual({
      type: "conversation",
      conversationId: id,
      state: "archived",
      closedHow: null,
    });
    await eraseAccount({ db: ctx.pool, logger: ctx.logger, now: () => new Date() }, b.accountId);
    expect(await pa.next((f) => f.type === "conversation")).toEqual({
      type: "conversation",
      conversationId: id,
      state: "closed",
      closedHow: "erasure",
    });
  });
});

describe("the socket's keepalive", () => {
  it("The ping asks the session, a pong keeps the socket, and silence or an expired token closes it", async () => {
    const a = await signedInAccount(ctx.pool);
    const kept = await signedIn(a.accessToken);
    ctx.timers.run(PING_MS);
    await kept.next((f) => f.type === "ping");
    const answered = ctx.timers.cancelled(PONG_MS);
    kept.send({ type: "pong" });
    await answered;
    // The deadline went with the pong: the socket stays.
    expect(kept.frames.some((f) => f.type === "error")).toBe(false);
    kept.close();
    expect((await kept.closed).code).toBe(1000);
    const silentAccount = await signedInAccount(ctx.pool);
    const silent = await signedIn(silentAccount.accessToken);
    ctx.timers.run(PING_MS);
    await silent.next((f) => f.type === "ping");
    ctx.timers.run(PONG_MS);
    expect(await silent.next((f) => f.type === "error")).toEqual({
      type: "error",
      code: "pong_timeout",
    });
    expect((await silent.closed).code).toBe(1001);

    const expiring = await signedInAccount(ctx.pool);
    const p = await signedIn(expiring.accessToken);
    await ctx.pool.query(
      "UPDATE session SET access_expires_at = now() - interval '1 minute' WHERE id = $1",
      [expiring.sessionId],
    );
    ctx.timers.run(PING_MS);
    expect(await p.next((f) => f.type === "error")).toEqual({
      type: "error",
      code: "session_expired",
    });
  });

  it("A lost listener closes every socket, and the phones resume from Postgres", async () => {
    const { a, b, id } = await pair();
    const pa = await signedIn(a.accessToken, [{ id, seq: 0 }]);
    const lost = ctx.log.next("chat listener lost");
    await ctx.pool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE 'LISTEN kuutti_chat%' AND datname = current_database()",
    );
    await lost;
    expect(await pa.next((f) => f.type === "error")).toEqual({ type: "error", code: "restarting" });
    expect((await pa.closed).code).toBe(1012);
    // A message meanwhile, then the listener back and the phone's resume.
    expect((await send(b.headers, id, "Kuuletko?")).status).toBe(201);
    // A phone that tries while the listener is down is told so, and tries later.
    const early = await phone();
    early.send({ type: "auth", token: a.accessToken });
    expect(await early.next((f) => f.type === "error")).toEqual({
      type: "error",
      code: "restarting",
    });
    expect((await early.closed).code).toBe(1012);
    const on = ctx.log.next("chat listener on");
    ctx.timers.run(1_000);
    await on;
    const back = await phone();
    back.send({ type: "auth", token: a.accessToken });
    await back.next((f) => f.type === "ready");
    back.send({ type: "resume", conversations: [{ id, seq: 0 }] });
    expect(await back.next(isMessage(id, 1))).toMatchObject({ message: { body: "Kuuletko?" } });
    // And live again.
    expect((await send(b.headers, id, "Nyt?")).status).toBe(201);
    expect(await back.next(isMessage(id, 2))).toMatchObject({ message: { body: "Nyt?" } });
  });
});

describe("what the listener hands the hub", () => {
  it("a notification outside the contract is dropped with a line naming its channel only", async () => {
    const refused = ctx.log.next("chat notification refused");
    await ctx.live.hub.deliver(`not json ${MARK}`);
    await refused;
    const again = ctx.log.next("chat notification refused");
    await ctx.live.hub.deliver(JSON.stringify({ t: "typing", c: randomUUID(), text: MARK }));
    await again;
    expect(ctx.log.text()).not.toContain(MARK);
  });
});

describe("what the socket tells the log", () => {
  it("no frame's text and no token reaches a log line", async () => {
    const { a, b, id } = await pair();
    const pa = await signedIn(a.accessToken, [{ id, seq: 0 }]);
    expect((await send(b.headers, id, `Salaisuus ${MARK}`)).status).toBe(201);
    await pa.next(isMessage(id, 1));
    const bad = await phone();
    bad.send({ type: "auth", token: a.accessToken, body: MARK });
    await bad.closed;
    const out = ctx.log.text();
    expect(out).not.toContain(MARK);
    expect(out).not.toContain(a.accessToken);
    expect(out).toContain("chat socket opened");
  });
});
