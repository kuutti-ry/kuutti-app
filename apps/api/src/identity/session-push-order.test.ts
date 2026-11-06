import type { Queryable } from "@kuutti/db";
import { expect, test } from "vitest";
import { createPush } from "../notifications/index.ts";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import { captureLogger } from "../test/harness.ts";
import { expectNamesNothing, heldSchedule, memoryPusher } from "../test/push.ts";
import { pidOf, type Watched, watched, withTwoConnections } from "../test/races.ts";
import { endAllSessions } from "./sessions.ts";

const AT = new Date("2026-11-06T10:00:00.000Z");
const END = new Date("2027-11-06T10:00:00.000Z");
const LOW = "00000000-0000-4000-8000-000000000001";
const HIGH = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const GATE = [65055, 1];

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("session/push race did not settle")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A real PostgreSQL lock edge; the sender's backend is chosen by the actual Pool. */
async function waitsForLock(
  db: Queryable,
  holder: number,
  settled: () => boolean,
  waiter: number | null = null,
): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await db.query<{ waits: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND ($1::int IS NULL OR pid = $1)
            AND $2::int = ANY(pg_blocking_pids(pid))
       ) AS waits`,
      [waiter, holder],
    );
    if (rows[0]?.waits) return true;
    if (settled()) return false;
  }
  throw new Error("expected session/push lock wait was not observed");
}

test("logout-all and push lock multiple sessions in the same order before revocation commits", async () => {
  await withTwoConnections("logout-all-push-lock-order", async (pool, writer, gateKeeper) => {
    const owner = await signedInAccount(pool, "logout-all-push-owner");
    const other = await signedInAccount(pool, "logout-all-unaffected-owner");
    await pool.query("DELETE FROM session WHERE account_id = $1", [owner.accountId]);
    await withMatchingConfig(pool, { push_quiet_from_hour: 0, push_quiet_to_hour: 0 });
    const devices = [
      { id: HIGH, token: "ExponentPushToken[logout-high]" },
      { id: LOW, token: "ExponentPushToken[logout-low]" },
    ];
    // Deliberately oppose physical insertion order and UUID lock order.
    // Both are live, committed sessions with a token before either actor starts.
    for (const [index, device] of devices.entries()) {
      await pool.query(
        `INSERT INTO session (
           id, account_id, platform, access_hash, access_expires_at,
           refresh_hash, family_hash, expires_at
         ) VALUES ($1, $2, 'ios', $3, $4, $5, $6, $4)`,
        [
          device.id,
          owner.accountId,
          `logout-access-${index}`,
          END,
          `logout-refresh-${index}`,
          `logout-family-${index}`,
        ],
      );
      await pool.query(
        `INSERT INTO push_token (account_id, session_id, token, platform, locale, created_at)
         VALUES ($1, $2, $3, 'ios', 'en', $4)`,
        [owner.accountId, device.id, device.token, new Date(AT.getTime() - 2_000 + index)],
      );
    }
    expect(
      (
        await pool.query("SELECT id FROM session WHERE account_id = $1 ORDER BY ctid", [
          owner.accountId,
        ])
      ).rows,
    ).toEqual([{ id: HIGH }, { id: LOW }]);

    // This trigger belongs only to the temporary test database. It pauses
    // inside the real writer's first update, after that row has been locked.
    // It never prelocks another session or changes the native statement.
    await pool.query(`CREATE FUNCTION test_pause_logout() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.revoked_at IS NULL AND NEW.revoked_reason = 'logout_all' THEN
          PERFORM pg_advisory_xact_lock(65055, 1);
        END IF;
        RETURN NEW;
      END
    $$`);
    await pool.query(`CREATE TRIGGER test_pause_logout
      BEFORE UPDATE OF revoked_at ON session
      FOR EACH ROW EXECUTE FUNCTION test_pause_logout()`);

    const { logger, lines } = await captureLogger();
    const pusher = memoryPusher();
    const schedule = heldSchedule();
    const push = createPush({
      db: pool,
      logger,
      now: () => AT,
      pusher,
      online: () => false,
      schedule: schedule.schedule,
      pause: async () => {},
    });
    const writerPid = await pidOf(writer);
    const keeperPid = await pidOf(gateKeeper);
    let ending: Watched<number> | undefined;
    await writer.query("BEGIN");
    try {
      await writer.query("SET LOCAL statement_timeout = '5s'");
      // A sequential scan is a valid native UPDATE plan. Forcing it makes
      // the unfixed writer visit HIGH first; an ordered CTE still locks LOW first.
      await writer.query("SET LOCAL enable_indexscan = off");
      await writer.query("SET LOCAL enable_indexonlyscan = off");
      await writer.query("SET LOCAL enable_bitmapscan = off");
      await gateKeeper.query("SELECT pg_advisory_lock($1, $2)", GATE);
      ending = watched(endAllSessions({ db: writer, now: () => AT }, owner.accountId));
      expect(await waitsForLock(pool, keeperPid, ending.settled, writerPid)).toBe(true);

      push.match({ accountId: owner.accountId });
      const sending = watched(push.settled());
      expect(await waitsForLock(pool, writerPid, sending.settled)).toBe(true);
      expect(pusher.sent()).toEqual([]);

      await gateKeeper.query("SELECT pg_advisory_unlock($1, $2)", GATE);
      expect(await bounded(ending.outcome)).toBe(2);
      await writer.query("COMMIT");
      expect(await bounded(sending.outcome)).toBeUndefined();
      // Push catches database failures internally. Require a clean outcome
      // as well as no delivery, so either possible deadlock victim fails this test.
      expect(lines().filter((line) => (line.level ?? 0) >= 40)).toEqual([]);
      expect(pusher.sent()).toEqual([]);
      expect(schedule.tasks).toEqual([]);
      expect(
        (
          await pool.query(
            "SELECT id, revoked_at, revoked_reason FROM session WHERE account_id = $1 ORDER BY id",
            [owner.accountId],
          )
        ).rows,
      ).toEqual([
        { id: LOW, revoked_at: AT, revoked_reason: "logout_all" },
        { id: HIGH, revoked_at: AT, revoked_reason: "logout_all" },
      ]);
      expect(
        (await pool.query("SELECT id FROM push_token WHERE account_id = $1", [owner.accountId]))
          .rows,
      ).toEqual([]);
      expect(
        (
          await pool.query("SELECT revoked_at FROM session WHERE account_id = $1", [
            other.accountId,
          ])
        ).rows,
      ).toEqual([{ revoked_at: null }]);
      push.match({ accountId: owner.accountId });
      await bounded(push.settled());
      expect(pusher.sent()).toEqual([]);
      expectNamesNothing(pusher.sent(), { ids: [owner.accountId, LOW, HIGH] });
      for (const device of devices) expect(JSON.stringify(lines())).not.toContain(device.token);
    } finally {
      await gateKeeper.query("SELECT pg_advisory_unlock($1, $2)", GATE);
      try {
        if (ending) await bounded(ending.outcome);
      } finally {
        await writer.query("ROLLBACK");
        await bounded(push.settled());
      }
    }
  });
});
