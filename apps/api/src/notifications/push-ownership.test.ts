import type { Pool, Queryable } from "@kuutti/db";
import { describe, expect, test } from "vitest";
import { endSessionsForSanction, eraseAccount } from "../identity/index.ts";
import { EXPO_PROJECT, MIXED_PROJECTS, PushFailed } from "../lib/push.ts";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import { captureLogger } from "../test/harness.ts";
import { deviceOf, expectNamesNothing, gate, heldSchedule, memoryPusher } from "../test/push.ts";
import { pidOf, type Watched, watched, withTwoConnections } from "../test/races.ts";
import { createPush, QUIET_FROM_KEY, QUIET_TO_KEY, REQUEST_SPACING_MS } from "./push.ts";
import { registerPushToken } from "./tokens.ts";

const AT = new Date("2026-11-06T10:00:00.000Z");
const LATER = new Date("2026-11-06T10:01:00.000Z");
const END = new Date("2027-11-06T10:00:00.000Z");

// These races need committed rows and independent transactions, so the
// sender receives the actual Pool, not the usual rolled-back test client.
// Provider gates and pg_blocking_pids establish the order. Time limits only
// fail a broken test; no sleep or timer chooses when a mutation may proceed.
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("push ownership race did not settle")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Finds a real lock edge in this test's isolated database, without assuming which pool backend sends. */
async function blocked(
  db: Queryable,
  connection: { holder: number } | { waiter: number },
  settled: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const holder = "holder" in connection;
    const { rows } = await db.query<{ waits: boolean }>(
      holder
        ? `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))
           ) AS waits`
        : "SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS waits",
      [holder ? connection.holder : connection.waiter],
    );
    if (rows[0]?.waits) return true;
    if (settled()) return false;
  }
  throw new Error("expected PostgreSQL lock wait was not observed");
}

async function scene(pool: Pool) {
  const owner = await signedInAccount(pool, "push-original-owner");
  const recipient = await signedInAccount(pool, "push-next-owner");
  // The helpers' login dates are irrelevant to the race: all lifetime
  // decisions here use the injected clock and these fixed expirations.
  await pool.query("UPDATE session SET expires_at = $2 WHERE account_id = ANY($1::uuid[])", [
    [owner.accountId, recipient.accountId],
    END,
  ]);
  await withMatchingConfig(pool, { [QUIET_FROM_KEY]: 0, [QUIET_TO_KEY]: 0 });
  const { rows } = await pool.query<{ identity_id: string }>(
    "SELECT identity_id FROM account WHERE id = $1",
    [owner.accountId],
  );
  const identityId = rows[0]?.identity_id;
  if (!identityId) throw new Error("test identity missing");
  const { logger, lines } = await captureLogger();
  const pusher = memoryPusher();
  const schedule = heldSchedule();
  const clock = { at: AT };
  const pauses: number[] = [];
  const control: { pause?: () => Promise<void> } = {};
  const push = createPush({
    db: pool,
    logger,
    pusher,
    now: () => clock.at,
    online: () => false,
    schedule: schedule.schedule,
    pause: async (ms) => {
      pauses.push(ms);
      await control.pause?.();
    },
  });
  const devices: Awaited<ReturnType<typeof deviceOf>>[] = [];
  async function device(expiresAt = END) {
    const result = await deviceOf(pool, owner.accountId, {
      at: new Date(AT.getTime() - 60_000 + devices.length),
      expiresAt,
    });
    devices.push(result);
    return result;
  }
  async function match(accountId = owner.accountId) {
    push.match({ accountId });
    await bounded(push.settled());
  }
  function privatePayloads() {
    expectNamesNothing(pusher.sent(), {
      ids: [owner.accountId, recipient.accountId, ...devices.map((item) => item.sessionId)],
    });
    const logs = JSON.stringify(lines());
    for (const item of devices) expect(logs).not.toContain(item.token);
  }
  return {
    owner,
    recipient,
    identityId,
    logger,
    lines,
    pusher,
    schedule,
    clock,
    pauses,
    control,
    push,
    device,
    match,
    privatePayloads,
  };
}

type Scene = Awaited<ReturnType<typeof scene>>;
type Device = Awaited<ReturnType<Scene["device"]>>;
type Mutation = "transfer" | "rebind" | "revoke" | "erase";

async function move(db: Queryable, s: Scene, device: Device, sameAccount = false) {
  const next = sameAccount ? s.owner : s.recipient;
  await registerPushToken(db, {
    accountId: next.accountId,
    sessionId: next.sessionId,
    token: device.token,
    platform: "ios",
    locale: "en",
    at: LATER,
  });
}

async function mutate(db: Queryable, s: Scene, device: Device, mutation: Mutation) {
  switch (mutation) {
    case "transfer":
    case "rebind":
      await move(db, s, device, mutation === "rebind");
      break;
    case "revoke":
      await endSessionsForSanction(db, {
        accountIds: [s.owner.accountId],
        identityId: s.identityId,
        at: LATER,
      });
      break;
    case "erase":
      await eraseAccount({ db, logger: s.logger, now: () => LATER }, s.owner.accountId);
      break;
  }
}

async function registration(db: Queryable, device: Device) {
  return (
    await db.query("SELECT id, account_id, session_id FROM push_token WHERE token = $1", [
      device.token,
    ])
  ).rows;
}

describe("push submission remains bound to its original token ownership", () => {
  test.each(["transfer", "rebind", "revoke", "erase"] as const)(
    "a %s committed before the first submission invalidates the already selected token",
    async (mutation) => {
      await withTwoConnections(`push-${mutation}-first`, async (pool, writer, observer) => {
        const s = await scene(pool);
        const device = await s.device();
        const writerPid = await pidOf(writer);
        await writer.query("BEGIN");
        await writer.query("SET LOCAL statement_timeout = '5s'");
        try {
          // The real writer has changed the row but not committed. The
          // initial nonlocking selection still sees its earlier ownership.
          await mutate(writer, s, device, mutation);
          s.push.match({ accountId: s.owner.accountId });
          const sending = watched(s.push.settled());
          expect(await blocked(observer, { holder: writerPid }, sending.settled)).toBe(true);
          expect(s.pusher.sent()).toEqual([]);
          await writer.query("COMMIT");
          expect(await bounded(sending.outcome)).toBeUndefined();
          expect(s.pusher.sent()).toEqual([]);
          expect(s.schedule.tasks).toEqual([]);

          if (mutation === "transfer" || mutation === "rebind") {
            const next = mutation === "rebind" ? s.owner : s.recipient;
            expect(await registration(pool, device)).toEqual([
              { id: device.tokenId, account_id: next.accountId, session_id: next.sessionId },
            ]);
            // A fresh delivery may use the new binding, even when its
            // account did not change. The stale delivery above may not.
            await s.match(next.accountId);
            expect(s.pusher.sent().map((message) => message.to)).toEqual([device.token]);
          } else {
            expect(await registration(pool, device)).toEqual([]);
            await s.match();
            expect(s.pusher.sent()).toEqual([]);
          }
          s.privatePayloads();
        } finally {
          await writer.query("ROLLBACK");
          await bounded(s.push.settled());
        }
      });
    },
  );

  test.each(["transfer", "rebind", "revoke", "erase"] as const)(
    "an authorized submission finishes before a concurrent %s can commit",
    async (mutation) => {
      await withTwoConnections(`push-send-before-${mutation}`, async (pool, writer, observer) => {
        const s = await scene(pool);
        const device = await s.device();
        const provider = gate();
        const reached = gate();
        s.pusher.gate = provider.promise;
        s.pusher.reached = reached.open;
        const writerPid = await pidOf(writer);
        let changing: Watched<void> | undefined;
        try {
          s.push.match({ accountId: s.owner.accountId });
          await bounded(reached.promise);
          await writer.query("BEGIN");
          await writer.query("SET LOCAL statement_timeout = '5s'");
          changing = watched(mutate(writer, s, device, mutation));
          expect(await blocked(observer, { waiter: writerPid }, changing.settled)).toBe(true);
          expect(changing.settled()).toBe(false);
          expect(s.pusher.sent().map((message) => message.to)).toEqual([device.token]);
          expect(s.schedule.tasks).toEqual([]);

          provider.open();
          expect(await bounded(changing.outcome)).toBeUndefined();
          await writer.query("COMMIT");
          await bounded(s.push.settled());
          expect(s.schedule.tasks).toHaveLength(1);
          await s.schedule.runAll();
          expect(s.pusher.asked).toEqual([["ticket-1"]]);

          if (mutation === "rebind") {
            expect(await registration(pool, device)).toEqual([
              { id: device.tokenId, account_id: s.owner.accountId, session_id: s.owner.sessionId },
            ]);
          } else {
            await s.match();
            expect(s.pusher.sent().map((message) => message.to)).toEqual([device.token]);
          }
          s.privatePayloads();
        } finally {
          provider.open();
          try {
            await bounded(s.push.settled());
            if (changing) await bounded(changing.outcome);
          } finally {
            await writer.query("ROLLBACK");
          }
        }
      });
    },
  );

  test("a session expiring while submission waits is refused at its exact expiry", async () => {
    await withTwoConnections("push-expired-before-send", async (pool, writer, observer) => {
      const s = await scene(pool);
      const device = await s.device(LATER);
      const writerPid = await pidOf(writer);
      await writer.query("BEGIN");
      try {
        await writer.query("SELECT id FROM session WHERE id = $1 FOR UPDATE", [device.sessionId]);
        s.push.match({ accountId: s.owner.accountId });
        const sending = watched(s.push.settled());
        expect(await blocked(observer, { holder: writerPid }, sending.settled)).toBe(true);
        s.clock.at = LATER;
        await writer.query("COMMIT");
        expect(await bounded(sending.outcome)).toBeUndefined();
        expect(s.pusher.sent()).toEqual([]);
        expect(s.schedule.tasks).toEqual([]);
        // Expiry suppresses delivery without treating the installation as dead.
        expect(await registration(pool, device)).toHaveLength(1);
        s.privatePayloads();
      } finally {
        await writer.query("ROLLBACK");
        await bounded(s.push.settled());
      }
    });
  });

  test("A queued push checks its device again before each submission", async () => {
    await withTwoConnections("push-transfer-between-batches", async (pool) => {
      const s = await scene(pool);
      for (let i = 0; i < 100; i += 1) await s.device();
      const moved = await s.device();
      const refused = await s.device();
      const receiptRefused = await s.device();
      const control = await s.device();
      const paused = gate();
      const resume = gate();
      s.control.pause = async () => {
        paused.open();
        await resume.promise;
      };
      s.pusher.ticket = (message) =>
        message.to === refused.token
          ? { status: "error", error: "DeviceNotRegistered" }
          : { status: "ok", id: `receipt-${message.to}` };
      s.pusher.receipt = (id) =>
        id === `receipt-${receiptRefused.token}`
          ? { status: "error", error: "DeviceNotRegistered" }
          : { status: "ok" };
      try {
        s.push.match({ accountId: s.owner.accountId });
        await bounded(paused.promise);
        expect(s.pusher.batches.map((batch) => batch.length)).toEqual([100]);
        await move(pool, s, moved);
        resume.open();
        await bounded(s.push.settled());
        expect(s.pusher.batches.map((batch) => batch.length)).toEqual([100, 3]);
        expect(s.pusher.batches[1]?.map((message) => message.to)).toEqual([
          refused.token,
          receiptRefused.token,
          control.token,
        ]);
        expect(s.pauses).toEqual([REQUEST_SPACING_MS]);
        expect(await registration(pool, refused)).toEqual([]);
        expect(await registration(pool, receiptRefused)).toHaveLength(1);
        await s.schedule.runAll();
        expect(s.pusher.asked.flat()).toHaveLength(102);
        expect(s.pusher.asked.flat()).not.toContain(`receipt-${moved.token}`);
        expect(s.pusher.asked.flat()).not.toContain(`receipt-${refused.token}`);
        expect(await registration(pool, receiptRefused)).toEqual([]);
        expect(await registration(pool, moved)).toEqual([
          {
            id: moved.tokenId,
            account_id: s.recipient.accountId,
            session_id: s.recipient.sessionId,
          },
        ]);
        expect(await registration(pool, control)).toHaveLength(1);
        s.privatePayloads();
      } finally {
        resume.open();
        await bounded(s.push.settled());
      }
    });
  });

  test("mixed-project recovery checks ownership again after its pause and retains successful cleanup", async () => {
    await withTwoConnections("push-transfer-before-recovery", async (pool) => {
      const s = await scene(pool);
      const stray = await s.device();
      const moved = await s.device();
      const control = await s.device();
      const paused = gate();
      const resume = gate();
      s.control.pause = async () => {
        paused.open();
        await resume.promise;
      };
      s.pusher.reached = () => {
        s.pusher.failure =
          s.pusher.batches.length === 1
            ? new PushFailed(MIXED_PROJECTS, 400, {
                "@other/project": [stray.token],
                [EXPO_PROJECT]: [moved.token, control.token],
              })
            : undefined;
      };
      try {
        s.push.match({ accountId: s.owner.accountId });
        await bounded(paused.promise);
        expect(await registration(pool, stray)).toEqual([]);
        await move(pool, s, moved);
        resume.open();
        await bounded(s.push.settled());
        expect(s.pusher.batches.map((batch) => batch.map((message) => message.to))).toEqual([
          [stray.token, moved.token, control.token],
          [control.token],
        ]);
        expect(s.pauses).toEqual([REQUEST_SPACING_MS]);
        expect(await registration(pool, moved)).toEqual([
          {
            id: moved.tokenId,
            account_id: s.recipient.accountId,
            session_id: s.recipient.sessionId,
          },
        ]);
        expect(await registration(pool, control)).toHaveLength(1);
        expect(s.schedule.tasks).toHaveLength(1);
        await s.schedule.runAll();
        expect(s.pusher.asked).toEqual([["ticket-1"]]);
        expect(
          s.lines().filter((line) => line.msg === "push tokens of another project gone"),
        ).toEqual([expect.objectContaining({ push: "match", strays: 1 })]);
        expect(s.lines().filter((line) => line.msg === "push not sent")).toEqual([]);
        s.privatePayloads();
      } finally {
        resume.open();
        await bounded(s.push.settled());
      }
    });
  });

  test("a rejected provider request releases its locks and lets the waiting transfer commit", async () => {
    await withTwoConnections("push-failure-releases-transfer", async (pool, writer, observer) => {
      const s = await scene(pool);
      const device = await s.device();
      const provider = gate();
      const reached = gate();
      s.pusher.gate = provider.promise;
      s.pusher.reached = reached.open;
      s.pusher.failure = new PushFailed("HTTP_ERROR", 503);
      const writerPid = await pidOf(writer);
      let changing: Watched<void> | undefined;
      try {
        s.push.match({ accountId: s.owner.accountId });
        await bounded(reached.promise);
        await writer.query("BEGIN");
        await writer.query("SET LOCAL statement_timeout = '5s'");
        changing = watched(move(writer, s, device));
        expect(await blocked(observer, { waiter: writerPid }, changing.settled)).toBe(true);
        provider.open();
        expect(await bounded(changing.outcome)).toBeUndefined();
        await writer.query("COMMIT");
        await bounded(s.push.settled());
        expect(s.schedule.tasks).toEqual([]);
        expect(s.lines().filter((line) => line.msg === "push not sent")).toEqual([
          expect.objectContaining({ push: "match", reason: "HTTP_ERROR", status: 503 }),
        ]);
        expect(await registration(pool, device)).toEqual([
          {
            id: device.tokenId,
            account_id: s.recipient.accountId,
            session_id: s.recipient.sessionId,
          },
        ]);
        await s.match();
        expect(s.pusher.batches).toHaveLength(1);
        s.pusher.failure = undefined;
        await s.match(s.recipient.accountId);
        expect(s.pusher.batches.map((batch) => batch.map((message) => message.to))).toEqual([
          [device.token],
          [device.token],
        ]);
        expect(s.schedule.tasks).toHaveLength(1);
        s.privatePayloads();
      } finally {
        provider.open();
        try {
          await bounded(s.push.settled());
          if (changing) await bounded(changing.outcome);
        } finally {
          await writer.query("ROLLBACK");
        }
      }
    });
  });
});
