import { createServer, type Server, type Socket } from "node:net";
import { createPool } from "@kuutti/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signedInAccount } from "../test/account.ts";
import { test, testPool } from "../test/harness.ts";
import { advisoryLock, checkDb, holdAccount, lockLiveAccount } from "./db.ts";

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

// The shared locks (#610): a name's advisory lock, and the account's row held or locked.

describe("advisoryLock", () => {
  test("holds its name for the caller's transaction, and only that name", async ({ ctx }) => {
    await advisoryLock(ctx.client, "lib_test:one");
    const other = await testPool().connect();
    try {
      await other.query("BEGIN");
      const tryLock = async (name: string) =>
        (
          await other.query<{ got: boolean }>(
            "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got",
            [name],
          )
        ).rows[0]?.got;
      expect(await tryLock("lib_test:one")).toBe(false);
      expect(await tryLock("lib_test:two")).toBe(true);
    } finally {
      await other.query("ROLLBACK");
      other.release();
    }
  });
});

describe.each([
  ["holdAccount", holdAccount],
  ["lockLiveAccount", lockLiveAccount],
])("%s", (_name, take) => {
  test("is true for a live account", async ({ ctx }) => {
    const { accountId } = await signedInAccount(ctx.client);
    expect(await take(ctx.client, accountId)).toBe(true);
  });

  test("is false for an erased account and for nobody", async ({ ctx }) => {
    const { accountId } = await signedInAccount(ctx.client);
    await ctx.client.query(
      "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
      [accountId],
    );
    expect(await take(ctx.client, accountId)).toBe(false);
    expect(await take(ctx.client, "00000000-0000-4000-8000-000000000000")).toBe(false);
  });
});
