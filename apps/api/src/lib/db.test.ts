import { createServer, type Server, type Socket } from "node:net";
import { createPool } from "@kuutti/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testPool } from "../test/harness.ts";
import { checkDb } from "./db.ts";

// The health probe's database check (#5): SELECT 1 under a hard timeout, where
// a database that does not answer is a state of the probe, never a hang.

describe("checkDb", () => {
  // A server that takes the connection and never says a word: a database that hangs, on this computer.
  let silent: Server;
  const sockets: Socket[] = [];
  let port = 0;
  beforeAll(async () => {
    silent = createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((ready) => silent.listen(0, "127.0.0.1", ready));
    port = (silent.address() as { port: number }).port;
  });
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((closed) => silent.close(closed));
  });

  it("is ok when the database answers", async () => {
    expect(await checkDb(testPool(), 2_000)).toBe("ok");
  });

  it("is unreachable when the connection is refused", async () => {
    const refused = createPool({
      connectionString: "postgres://kuutti:kuutti@127.0.0.1:1/kuutti_test",
      max: 1,
      connectionTimeoutMillis: 300,
    });
    try {
      expect(await checkDb(refused, 2_000)).toBe("unreachable");
    } finally {
      await refused.end();
    }
  });

  it("is unreachable once the timeout passes on a database that never answers", async () => {
    const hanging = createPool({
      connectionString: `postgres://kuutti:kuutti@127.0.0.1:${port}/kuutti_test`,
      max: 1,
      connectionTimeoutMillis: 1_000,
    });
    try {
      const started = performance.now();
      expect(await checkDb(hanging, 50)).toBe("unreachable");
      const waited = performance.now() - started;
      expect(waited).toBeGreaterThanOrEqual(45);
      expect(waited).toBeLessThan(900);
    } finally {
      for (const socket of sockets) socket.destroy();
      await hanging.end().catch(() => undefined);
    }
  });
});
