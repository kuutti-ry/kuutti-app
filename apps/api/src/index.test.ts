import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";
import { createPool, withTemporaryDatabase } from "@kuutti/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { signedInAccount } from "./test/account.ts";

// The process around boot.ts (index.ts): the server, its one failure that has
// a name, and the signals a redeploy sends. Each case is the real entry in a
// process of its own, against a database of its own (a boot migrates and
// counts, which commits). The configuration's own refusal is config.test.ts.

const API_DIR = resolve(import.meta.dirname, "..");

let databaseUrl: string;
let release: () => void;
let held: Promise<void>;
beforeAll(async () => {
  await new Promise<void>((ready) => {
    held = withTemporaryDatabase(async (url) => {
      databaseUrl = url;
      ready();
      await new Promise<void>((done) => {
        release = done;
      });
    });
  });
});
afterAll(async () => {
  release();
  await held;
});

type Line = { msg?: string; level?: number; port?: number; signal?: string };

// A child a failed test left running is stopped, so its database can go.
const started: ChildProcess[] = [];
afterEach(() => {
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

/** The API on a port, with what it logs as JSON lines, and its exit. */
function api(port: number) {
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: API_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "test",
      APP_ENV: "test",
      LOG_LEVEL: "info",
      APP_VERSION: "0.0.0-test",
      GIT_COMMIT: "test",
      DATABASE_URL: databaseUrl,
      PORT: String(port),
    },
  });
  started.push(child);
  const lines: Line[] = [];
  let buffered = "";
  const waiting: { msg: string; found: (line: Line) => void }[] = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    const complete = buffered.split("\n");
    buffered = complete.pop() ?? "";
    for (const text of complete) {
      if (!text.startsWith("{")) continue;
      const line = JSON.parse(text) as Line;
      lines.push(line);
      for (const w of waiting.filter((w) => w.msg === line.msg)) w.found(line);
    }
  });
  // "close", not "exit": by then every line the process wrote has been read.
  const exited = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
  // A line that never comes fails at the process's exit, not at the test's timeout.
  const logged = (msg: string) =>
    new Promise<Line>((found, missed) => {
      const already = lines.find((l) => l.msg === msg);
      if (already) found(already);
      else waiting.push({ msg, found });
      void exited.then((code) => missed(new Error(`exited ${code} before "${msg}"`)));
    });
  return { child, lines, exited, logged };
}

async function listening(host: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((ready) => server.listen(0, host, ready));
  return server;
}
const portOf = (server: Server) => (server.address() as { port: number }).port;

describe("the API process", () => {
  it("names a port that is already taken, and exits 1", async () => {
    const taken = await listening("0.0.0.0");
    try {
      const port = portOf(taken);
      const { exited, lines } = api(port);
      expect(await exited).toBe(1);
      const fatal = lines.find((l) => l.level === 60);
      expect(fatal).toMatchObject({
        port,
        msg: `port ${port} is already in use: another API is running, stop it or set PORT`,
      });
      // It got that far: booted, then failed to listen.
      expect(lines.some((l) => l.msg === "migrations")).toBe(true);
      expect(lines.some((l) => l.msg === "API listening")).toBe(false);
    } finally {
      await new Promise((closed) => taken.close(closed));
    }
  }, 60_000);

  it.each(["SIGTERM", "SIGINT"] as const)(
    "listens, and on %s drains and exits 0",
    async (signal) => {
      const probe = await listening("0.0.0.0");
      const port = portOf(probe);
      await new Promise((closed) => probe.close(closed));
      const { child, exited, logged } = api(port);
      expect(await logged("API listening")).toMatchObject({ port });
      child.kill(signal);
      expect(await logged("shutting down")).toMatchObject({ signal });
      expect(await exited).toBe(0);
    },
    60_000,
  );

  // #349: an open socket would hold the server open past the 10 s exit; it
  // is told `restarting` and closed, and the process still exits 0.
  it("closes an open chat socket on SIGTERM with restarting, and still exits 0", async () => {
    const probe = await listening("0.0.0.0");
    const port = portOf(probe);
    await new Promise((closed) => probe.close(closed));
    const { child, exited, logged } = api(port);
    await logged("chat listener on");
    await logged("API listening");
    const pool = createPool({ connectionString: databaseUrl, max: 1 });
    const person = await signedInAccount(pool).finally(() => pool.end());
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: string[] = [];
    socket.on("message", (data) => frames.push(String(data)));
    const closed = new Promise<number>((done) => socket.on("close", (code) => done(code)));
    await new Promise<void>((open) => socket.once("open", () => open()));
    const ready = new Promise<void>((done) =>
      socket.on("message", (data) => {
        if (String(data).includes('"ready"')) done();
      }),
    );
    socket.send(JSON.stringify({ type: "auth", token: person.accessToken }));
    await ready;
    child.kill("SIGTERM");
    expect(await closed).toBe(1012);
    expect(frames).toContain(JSON.stringify({ type: "error", code: "restarting" }));
    expect(await exited).toBe(0);
  }, 60_000);
});
