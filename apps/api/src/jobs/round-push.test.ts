import type { Queryable } from "@kuutti/db";
import { afterEach, describe, expect, vi } from "vitest";
import { finnishDay } from "../lib/finnish-day.ts";
import { createLogger } from "../lib/logger.ts";
import { saveRound } from "../matching/index.ts";
import { createPush, type Push } from "../notifications/index.ts";
import { withMatchingConfig } from "../test/account.ts";
import { captureLogger, type LogLine, type TestContext, test } from "../test/harness.ts";
import { people } from "../test/people.ts";
import { deviceOf, expectNamesNothing, heldSchedule, memoryPusher } from "../test/push.ts";
import {
  ROUND_PUSH_HOUR_KEY,
  ROUND_PUSH_IDLE_DAYS_KEY,
  RUN_RETRIES,
  RUN_RETRY_MS,
  runRoundPush,
  scheduleRoundPush,
} from "./round-push.ts";

// The round's push (#102, ADR-055 §6, features/notifications/push.feature):
// whom one run tells, on the real database in the harness's transaction with
// rounds written as the builder writes them, and the timer around it, on
// vitest's fake clock, waiting on what it logs, never on a sleep.

/** 12:00 in Helsinki, a Friday in summer time (UTC+3): the quiet hours begin ten hours later. */
const T = new Date("2026-10-16T09:00:00.000Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

afterEach(() => {
  vi.useRealTimers();
});

/** A round for `owner` on `at`'s Finnish day, these people its cards, as the builder saves one. */
async function roundOf(db: Queryable, owner: string, cards: string[], at: Date = T) {
  const built = await saveRound(
    { db, logger: (await captureLogger()).logger, now: () => at },
    {
      accountId: owner,
      day: finnishDay(at),
      ordering: "count",
      entries: cards.map((candidateId) => ({ candidateId, reason: "matches_filters" })),
    },
  );
  if (!built) throw new Error("round not built");
  return built.roundId;
}

async function block(db: Queryable, blocker: string, blocked: string) {
  await db.query(
    `INSERT INTO block (blocker_identity_id, blocked_identity_id)
     SELECT x.identity_id, y.identity_id FROM account x, account y WHERE x.id = $1 AND y.id = $2`,
    [blocker, blocked],
  );
}

async function pushAt(ctx: TestContext, at: Date) {
  const { logger, lines } = await captureLogger();
  const pusher = memoryPusher();
  const push = createPush({
    db: ctx.client,
    logger,
    now: () => at,
    pusher,
    online: () => false,
    schedule: heldSchedule().schedule,
  });
  return { deps: { db: ctx.client, logger, now: () => at, push }, pusher, lines };
}

describe("one run of the round's push (ADR-055 §6)", () => {
  test("Today's round is told once to those who have not opened it", async ({ ctx }) => {
    const ids = await people(ctx.client, null, 15, { complete: true });
    const [told, opened, empty, erasedCard, blockedCard, yesterday, paused, banned, mixed] = ids;
    const [card, second, erased, blockedOne, switchedOff, alsoTold] = ids.slice(9);
    if (!told || !opened || !empty || !erasedCard || !blockedCard || !yesterday || !paused) {
      throw new Error("no people");
    }
    if (
      !banned ||
      !mixed ||
      !card ||
      !second ||
      !erased ||
      !blockedOne ||
      !switchedOff ||
      !alsoTold
    ) {
      throw new Error("no people");
    }
    // Built today and not opened, a card that can be shown: told.
    await roundOf(ctx.client, told, [card, second]);
    // Opened already.
    const openedRound = await roundOf(ctx.client, opened, [card]);
    await ctx.client.query("UPDATE rounds SET opened_at = $2 WHERE id = $1", [openedRound, T]);
    // Empty.
    await roundOf(ctx.client, empty, []);
    // Its only card erased since, or blocked since; one of two erased still has a card.
    await roundOf(ctx.client, erasedCard, [erased]);
    await roundOf(ctx.client, blockedCard, [blockedOne]);
    await roundOf(ctx.client, mixed, [erased, second]);
    await ctx.client.query("UPDATE account SET state = 'deleted' WHERE id = $1", [erased]);
    await block(ctx.client, blockedOne, blockedCard);
    // Yesterday's round, never opened.
    await roundOf(ctx.client, yesterday, [card], new Date(T.getTime() - DAY));
    // An owner on a break or banned since the night built their round.
    await roundOf(ctx.client, paused, [card]);
    await roundOf(ctx.client, banned, [card]);
    await ctx.client.query(
      "UPDATE account SET state = CASE id WHEN $1::uuid THEN 'paused'::account_state ELSE 'banned'::account_state END WHERE id IN ($1, $2)",
      [paused, banned],
    );
    // Somebody who switched the round off is counted but not told.
    await roundOf(ctx.client, switchedOff, [card]);
    await ctx.client.query(
      "INSERT INTO notification_preference (account_id, kind, enabled) VALUES ($1, 'round', false)",
      [switchedOff],
    );
    // Two devices: one push each.
    await roundOf(ctx.client, alsoTold, [second]);
    const devices = new Map<string, string[]>();
    for (const owner of ids) {
      devices.set(owner, [(await deviceOf(ctx.client, owner, { locale: "fi" })).token]);
    }
    devices.get(alsoTold)?.push((await deviceOf(ctx.client, alsoTold)).token);

    const { deps, pusher } = await pushAt(ctx, T);
    const outcome = await runRoundPush(deps);

    expect(outcome).toEqual({ rounds: 4, pushed: 4 });
    const toldTokens = [told, mixed, alsoTold].flatMap((owner) => devices.get(owner) ?? []);
    expect(new Set(pusher.sent().map((m) => m.to))).toEqual(new Set(toldTokens));
    expect(pusher.sent()).toHaveLength(4);
    for (const message of pusher.sent()) {
      expect(message).toMatchObject({
        data: { kind: "round" },
        collapseId: "round",
        tag: "round",
        priority: "normal",
        // Ten hours to the quiet hours at 22:00 in Helsinki.
        ttl: 10 * 60 * 60,
      });
    }
    expect(pusher.sent().map((m) => m.body)).toContain("Päivän kierros on valmis");
    // Once: the run again, after the round has been opened, tells nobody.
    await ctx.client.query("UPDATE rounds SET opened_at = $2 WHERE account_id = ANY($1::uuid[])", [
      [told, mixed, alsoTold, switchedOff],
      T,
    ]);
    expect(await runRoundPush(deps)).toEqual({ rounds: 0, pushed: 0 });
    expect(pusher.batches).toHaveLength(1);
    expectNamesNothing(pusher.sent(), { ids });
  });

  test("a shadow-banned owner's round is told as anybody's, since a shadow ban shows its owner nothing", async ({
    ctx,
  }) => {
    const [owner, card] = await people(ctx.client, null, 2, { complete: true });
    if (!owner || !card) throw new Error("no people");
    await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [owner]);
    // The builder builds a shadow-banned person's round (ADR-024 §7).
    await roundOf(ctx.client, owner, [card]);
    const device = await deviceOf(ctx.client, owner);
    const { deps, pusher } = await pushAt(ctx, T);
    expect(await runRoundPush(deps)).toEqual({ rounds: 1, pushed: 1 });
    expect(pusher.sent().map((m) => m.to)).toEqual([device.token]);
  });

  test("lives until the quiet hours begin or the Finnish day ends, whichever is sooner", async ({
    ctx,
  }) => {
    const [owner, card] = await people(ctx.client, null, 2, { complete: true });
    if (!owner || !card) throw new Error("no people");
    await deviceOf(ctx.client, owner);
    const cases: Array<[string, number, number]> = [
      // 12:00 in summer time, quiet from 22: ten hours.
      ["2026-10-16T09:00:00.000Z", 22, 10 * 3600],
      // No quiet hours, so the evening can be told: the day's end alone.
      // 12:00: twelve hours.
      ["2026-10-16T09:00:00.000Z", 0, 12 * 3600],
      // 23:58 in Helsinki: two minutes.
      ["2026-10-16T20:58:00.000Z", 0, 120],
      // 23:59:30: thirty seconds.
      ["2026-10-16T20:59:30.000Z", 0, 30],
      // 12:00 on the day summer time ends, now UTC+2: twelve hours to its midnight.
      ["2026-10-25T10:00:00.000Z", 0, 12 * 3600],
      // 12:00 in winter, on a day that is not T's.
      ["2026-12-01T10:00:00.000Z", 0, 12 * 3600],
    ];
    for (const [at, quietFrom, ttl] of cases) {
      await withMatchingConfig(ctx.client, {
        push_quiet_from_hour: quietFrom,
        push_quiet_to_hour: quietFrom === 0 ? 0 : 8,
      });
      const when = new Date(at);
      await ctx.client.query("DELETE FROM rounds WHERE account_id = $1", [owner]);
      await roundOf(ctx.client, owner, [card], when);
      const { deps, pusher } = await pushAt(ctx, when);
      expect(await runRoundPush(deps), at).toEqual({ rounds: 1, pushed: 1 });
      expect(pusher.sent()[0]?.ttl, `${at} quiet from ${quietFrom}`).toBe(ttl);
    }
  });

  test("tells nobody who opened no round in round_push_idle_days, counting from the first round of somebody who never opened one", async ({
    ctx,
  }) => {
    const ids = await people(ctx.client, null, 8, { complete: true });
    const [recent, stale, staleSinceBuilt, newcomer, oldcomer, firstToday, shadowRecent, card] =
      ids;
    if (!recent || !stale || !staleSinceBuilt || !newcomer || !oldcomer || !firstToday) {
      throw new Error("no people");
    }
    if (!shadowRecent || !card) throw new Error("no people");
    const daysAgo = (days: number) => new Date(T.getTime() - days * DAY);
    const opened = async (owner: string, days: number) => {
      const round = await roundOf(ctx.client, owner, [card], daysAgo(days));
      await ctx.client.query("UPDATE rounds SET opened_at = $2 WHERE id = $1", [
        round,
        daysAgo(days),
      ]);
    };
    // Opened one seven days ago: within round_push_idle_days, 7. Told.
    await opened(recent, 7);
    // Last opened one eight days ago: not told.
    await opened(stale, 8);
    // The same, with a round built since and never opened: having one is not opening one.
    await opened(staleSinceBuilt, 8);
    await roundOf(ctx.client, staleSinceBuilt, [card], daysAgo(3));
    // Never opened one, the first seven days ago: told; eight days ago: not.
    await roundOf(ctx.client, newcomer, [card], daysAgo(7));
    await roundOf(ctx.client, oldcomer, [card], daysAgo(8));
    await roundOf(ctx.client, oldcomer, [card], daysAgo(1));
    // A shadow-banned owner who opened one lately is told as anybody (ADR-024 §7).
    await opened(shadowRecent, 2);
    await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [
      shadowRecent,
    ]);
    // Everybody has today's round, unopened, with a card to show; firstToday's is their first.
    const owners = [recent, stale, staleSinceBuilt, newcomer, oldcomer, firstToday, shadowRecent];
    for (const owner of owners) {
      await roundOf(ctx.client, owner, [card]);
      await deviceOf(ctx.client, owner);
    }
    const told = [recent, newcomer, firstToday, shadowRecent].sort();

    const { deps, pusher } = await pushAt(ctx, T);
    expect(await runRoundPush(deps)).toEqual({ rounds: 4, pushed: 4 });
    expect(pusher.sent()).toHaveLength(4);
    const { rows } = await ctx.client.query<{ account_id: string }>(
      "SELECT account_id FROM push_token WHERE token = ANY($1::text[]) ORDER BY account_id",
      [pusher.sent().map((m) => m.to)],
    );
    expect(rows.map((row) => row.account_id)).toEqual(told);

    // The days are read from matching_config: with 2, only those within two days.
    await withMatchingConfig(ctx.client, { [ROUND_PUSH_IDLE_DAYS_KEY]: 2 });
    const two = await pushAt(ctx, T);
    expect(await runRoundPush(two.deps)).toEqual({ rounds: 2, pushed: 2 });
    // With none, only somebody whose first round is today's.
    await withMatchingConfig(ctx.client, { [ROUND_PUSH_IDLE_DAYS_KEY]: 0 });
    const none = await pushAt(ctx, T);
    expect(await runRoundPush(none.deps)).toEqual({ rounds: 1, pushed: 1 });
    // A fraction or a negative number of days fails the run, naming the row, and tells nobody.
    for (const days of [2.5, -1]) {
      await withMatchingConfig(ctx.client, { [ROUND_PUSH_IDLE_DAYS_KEY]: days });
      await expect(runRoundPush(none.deps), String(days)).rejects.toThrow(
        /round_push_idle_days is not a number of days/,
      );
    }
    // The row missing fails the run, naming it.
    await ctx.client.query("DELETE FROM matching_config WHERE key = $1", [
      ROUND_PUSH_IDLE_DAYS_KEY,
    ]);
    await expect(runRoundPush(none.deps)).rejects.toThrow(/round_push_idle_days/);
    expect(none.pusher.batches).toHaveLength(1);
  });

  test("tells nobody when nobody has a round, and sends nothing", async ({ ctx }) => {
    const { deps, pusher } = await pushAt(ctx, T);
    expect(await runRoundPush(deps)).toEqual({ rounds: 0, pushed: 0 });
    expect(pusher.batches).toEqual([]);
  });
});

/** A logger whose lines the test can wait for: a timer's run is seen in what it logs. */
async function watchedLogger() {
  const lines: LogLine[] = [];
  const waiting: Array<{ msg: string; count: number; resolve: () => void }> = [];
  const count = (msg: string) => lines.filter((line) => line.msg === msg).length;
  const logger = await createLogger({
    level: "trace",
    pretty: false,
    destination: {
      write: (raw) => {
        lines.push(JSON.parse(raw) as LogLine);
        for (const waiter of [...waiting]) {
          if (count(waiter.msg) >= waiter.count) {
            waiting.splice(waiting.indexOf(waiter), 1);
            waiter.resolve();
          }
        }
      },
    },
  });
  return {
    logger,
    lines: () => lines,
    /** Resolves once `msg` has been logged `times` times. */
    until: (msg: string, times: number) =>
      count(msg) >= times
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiting.push({ msg, count: times, resolve })),
    armed: () => lines.filter((line) => line.msg === "round push armed").map((line) => line.inMs),
  };
}

/** A push that records the round's calls, with when each came; the others are not the timer's. */
function recordingPush(fail: (call: number) => boolean = () => false) {
  const calls: Array<{ at: string; day: string; accountIds: readonly string[] }> = [];
  const push: Push = {
    message: () => {},
    match: () => {},
    round: async (accountIds) => {
      const at = new Date();
      calls.push({ at: at.toISOString(), day: finnishDay(at), accountIds });
      if (fail(calls.length)) throw new Error("push broke");
      return accountIds.length;
    },
    settled: async () => {},
  };
  return { push, calls };
}

const FAKE = { toFake: ["setTimeout", "clearTimeout", "Date"] as const };

describe("the round's push on its timer (ADR-055 §6)", () => {
  test("is armed to the next round_push_hour, runs once at it, and again a day later, until it is stopped", async ({
    ctx,
  }) => {
    const [owner, card] = await people(ctx.client, null, 2, { complete: true });
    if (!owner || !card) throw new Error("no people");
    // 08:00 in Helsinki: the hour is an hour away.
    vi.useFakeTimers({ now: new Date("2026-10-16T05:00:00.000Z"), toFake: [...FAKE.toFake] });
    await roundOf(ctx.client, owner, [card], new Date());
    const log = await watchedLogger();
    const { push, calls } = recordingPush();
    const stop = scheduleRoundPush({
      db: ctx.client,
      logger: log.logger,
      now: () => new Date(),
      push,
    });
    try {
      await log.until("round push armed", 1);
      expect(log.armed()).toEqual([HOUR]);
      await vi.advanceTimersByTimeAsync(HOUR - 1);
      expect(calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await log.until("round push armed", 2);
      expect(calls).toEqual([
        { at: "2026-10-16T06:00:00.000Z", day: "2026-10-16", accountIds: [owner] },
      ]);
      expect(log.lines().find((line) => line.msg === "round push done")).toMatchObject({
        job: "round-push",
        rounds: 1,
        pushed: 1,
      });
      expect(log.armed()).toEqual([HOUR, DAY]);
      // The next day: nobody has a round, and the run says so.
      await vi.advanceTimersByTimeAsync(DAY);
      await log.until("round push armed", 3);
      expect(calls.map((call) => [call.at, call.accountIds.length])).toEqual([
        ["2026-10-16T06:00:00.000Z", 1],
        ["2026-10-17T06:00:00.000Z", 0],
      ]);
      stop();
      await vi.advanceTimersByTimeAsync(3 * DAY);
      expect(calls).toHaveLength(2);
      expect(log.armed()).toHaveLength(3);
    } finally {
      stop();
    }
  });

  test("reads the hour at each arming, so a new one holds from then, and never tells a Finnish day twice", async ({
    ctx,
  }) => {
    vi.useFakeTimers({ now: new Date("2026-10-16T05:00:00.000Z"), toFake: [...FAKE.toFake] });
    const log = await watchedLogger();
    const { push, calls } = recordingPush();
    const stop = scheduleRoundPush({
      db: ctx.client,
      logger: log.logger,
      now: () => new Date(),
      push,
    });
    try {
      await log.until("round push armed", 1);
      // Before 09:00 comes, the hour becomes 10: the arming after the run reads it.
      await withMatchingConfig(ctx.client, { [ROUND_PUSH_HOUR_KEY]: 10 });
      await vi.advanceTimersByTimeAsync(HOUR);
      await log.until("round push armed", 2);
      // 10:00 the same day: the day was told at 09:00, so nothing more.
      await vi.advanceTimersByTimeAsync(HOUR);
      await log.until("round push armed", 3);
      expect(log.armed()).toEqual([HOUR, HOUR, DAY]);
      expect(calls.map((call) => call.at)).toEqual(["2026-10-16T06:00:00.000Z"]);
      await vi.advanceTimersByTimeAsync(DAY);
      await log.until("round push armed", 4);
      expect(calls.map((call) => call.at)).toEqual([
        "2026-10-16T06:00:00.000Z",
        "2026-10-17T07:00:00.000Z",
      ]);
    } finally {
      stop();
    }
  });

  test("tells each Finnish day once, at the hour, across the change from summer time", async ({
    ctx,
  }) => {
    // 08:00 in Helsinki on the Saturday before summer time ends.
    vi.useFakeTimers({ now: new Date("2026-10-24T05:00:00.000Z"), toFake: [...FAKE.toFake] });
    const log = await watchedLogger();
    const { push, calls } = recordingPush();
    const stop = scheduleRoundPush({
      db: ctx.client,
      logger: log.logger,
      now: () => new Date(),
      push,
    });
    try {
      await log.until("round push armed", 1);
      for (let armings = 2; armings <= 5; armings += 1) {
        const [wait] = log.armed().slice(-1);
        await vi.advanceTimersByTimeAsync(Number(wait));
        await log.until("round push armed", armings);
      }
      // Each day once, at 09:00 in Helsinki on either side of the change:
      // 06:00 UTC in summer time, 07:00 UTC after it.
      expect(calls.map((call) => call.day)).toEqual([
        "2026-10-24",
        "2026-10-25",
        "2026-10-26",
        "2026-10-27",
      ]);
      expect(calls.map((call) => call.at)).toEqual([
        "2026-10-24T06:00:00.000Z",
        "2026-10-25T07:00:00.000Z",
        "2026-10-26T07:00:00.000Z",
        "2026-10-27T07:00:00.000Z",
      ]);
    } finally {
      stop();
    }
  });

  test("a run that fails is tried again RUN_RETRIES times RUN_RETRY_MS apart the same day, then left to tomorrow, whose own failure is tried again", async ({
    ctx,
  }) => {
    // 08:59 in Helsinki: the hour is a minute away.
    vi.useFakeTimers({ now: new Date("2026-10-16T05:59:00.000Z"), toFake: [...FAKE.toFake] });
    const log = await watchedLogger();
    // The day's run and its three retries fail; the next day's first run fails, its retry does not.
    const { push, calls } = recordingPush((call) => call <= RUN_RETRIES + 2);
    const stop = scheduleRoundPush({
      db: ctx.client,
      logger: log.logger,
      now: () => new Date(),
      push,
    });
    const failed = () => log.lines().filter((line) => line.msg === "round push failed");
    try {
      expect([RUN_RETRIES, RUN_RETRY_MS]).toEqual([3, 5 * MINUTE]);
      await log.until("round push armed", 1);
      await vi.advanceTimersByTimeAsync(MINUTE);
      await log.until("round push failed", 1);
      // Tried again RUN_RETRY_MS later, not sooner, and not armed meanwhile.
      await vi.advanceTimersByTimeAsync(RUN_RETRY_MS - 1);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await log.until("round push failed", 2);
      for (let failures = 3; failures <= RUN_RETRIES + 1; failures += 1) {
        await vi.advanceTimersByTimeAsync(RUN_RETRY_MS);
        await log.until("round push failed", failures);
      }
      // Its retries spent, the day is left: armed for tomorrow's 09:00, 23 h 45 min on.
      await log.until("round push armed", 2);
      expect(log.armed()).toEqual([MINUTE, DAY - 15 * MINUTE]);
      expect(calls.map((call) => call.at)).toEqual([
        "2026-10-16T06:00:00.000Z",
        "2026-10-16T06:05:00.000Z",
        "2026-10-16T06:10:00.000Z",
        "2026-10-16T06:15:00.000Z",
      ]);
      expect(failed().map((line) => [line.job, line.level, line.again])).toEqual([
        ["round-push", 50, true],
        ["round-push", 50, true],
        ["round-push", 50, true],
        ["round-push", 50, false],
      ]);
      // The next day counts its own failures: its first is tried again, and told.
      await vi.advanceTimersByTimeAsync(DAY - 15 * MINUTE);
      await log.until("round push failed", RUN_RETRIES + 2);
      expect(failed().at(-1)?.again).toBe(true);
      await vi.advanceTimersByTimeAsync(RUN_RETRY_MS);
      await log.until("round push done", 1);
      expect(calls.map((call) => call.at).slice(-2)).toEqual([
        "2026-10-17T06:00:00.000Z",
        "2026-10-17T06:05:00.000Z",
      ]);
    } finally {
      stop();
    }
  });

  test("a retry that would run past midnight is given up, and the next day is told at its hour", async ({
    ctx,
  }) => {
    // The hour at 23 (an hour asHour takes): 22:59 in Helsinki, summer time.
    await withMatchingConfig(ctx.client, { [ROUND_PUSH_HOUR_KEY]: 23 });
    vi.useFakeTimers({ now: new Date("2026-07-01T19:59:00.000Z"), toFake: [...FAKE.toFake] });
    const log = await watchedLogger();
    // The scheduler's clock: the fake one, until the day's run hangs for 58 minutes.
    let late = 0;
    const now = () => new Date(Date.now() + late);
    const runs: string[] = [];
    const push: Push = {
      message: () => {},
      match: () => {},
      settled: async () => {},
      round: async () => {
        runs.push(now().toISOString());
        if (runs.length === 1) {
          late = 58 * MINUTE;
          throw new Error("the database hung, then broke");
        }
        return 0;
      },
    };
    const stop = scheduleRoundPush({ db: ctx.client, logger: log.logger, now, push });
    try {
      await log.until("round push armed", 1);
      await vi.advanceTimersByTimeAsync(MINUTE);
      await log.until("round push failed", 1);
      // Its retry comes at 00:03 of the next day: given up, never run for the day before.
      await vi.advanceTimersByTimeAsync(RUN_RETRY_MS);
      await log.until("round push given up: the day ended", 1);
      expect(runs).toHaveLength(1);
      // Armed for the new day's 23:00, 22 h 57 min on, which is told.
      await log.until("round push armed", 2);
      expect(log.armed().at(-1)).toBe(DAY - 63 * MINUTE);
      await vi.advanceTimersByTimeAsync(DAY - 63 * MINUTE);
      await log.until("round push done", 1);
      expect(runs).toEqual(["2026-07-01T20:00:00.000Z", "2026-07-02T20:00:00.000Z"]);
    } finally {
      stop();
    }
  });

  test("a retry that succeeds tells the day once, and the next run is the next day's", async ({
    ctx,
  }) => {
    vi.useFakeTimers({ now: new Date("2026-10-16T05:59:00.000Z"), toFake: [...FAKE.toFake] });
    const log = await watchedLogger();
    const { push, calls } = recordingPush((call) => call === 1);
    const stop = scheduleRoundPush({
      db: ctx.client,
      logger: log.logger,
      now: () => new Date(),
      push,
    });
    try {
      await log.until("round push armed", 1);
      await vi.advanceTimersByTimeAsync(MINUTE);
      await log.until("round push failed", 1);
      // The failure told nobody, so the day is still to be told: the retry runs it.
      await vi.advanceTimersByTimeAsync(RUN_RETRY_MS);
      await log.until("round push done", 1);
      await log.until("round push armed", 2);
      expect(log.armed()).toEqual([MINUTE, DAY - 5 * MINUTE]);
      await vi.advanceTimersByTimeAsync(DAY - 5 * MINUTE);
      await log.until("round push done", 2);
      expect(calls.map((call) => call.at)).toEqual([
        "2026-10-16T06:00:00.000Z",
        "2026-10-16T06:05:00.000Z",
        "2026-10-17T06:00:00.000Z",
      ]);
      expect(log.lines().filter((line) => line.msg === "round push failed")).toHaveLength(1);
    } finally {
      stop();
    }
  });

  test("stopped while it waits to try a failed run again, it tries no more", async ({ ctx }) => {
    vi.useFakeTimers({ now: new Date("2026-10-16T05:59:00.000Z"), toFake: [...FAKE.toFake] });
    const log = await watchedLogger();
    const { push, calls } = recordingPush(() => true);
    const stop = scheduleRoundPush({
      db: ctx.client,
      logger: log.logger,
      now: () => new Date(),
      push,
    });
    await log.until("round push armed", 1);
    await vi.advanceTimersByTimeAsync(MINUTE);
    await log.until("round push failed", 1);
    stop();
    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(calls).toHaveLength(1);
    expect(log.armed()).toHaveLength(1);
  });

  test("an hour that cannot be read is logged, tried again an hour later, and armed once it can", async ({
    ctx,
  }) => {
    vi.useFakeTimers({ now: new Date("2026-10-16T03:00:00.000Z"), toFake: [...FAKE.toFake] });
    await ctx.client.query("DELETE FROM matching_config WHERE key = $1", [ROUND_PUSH_HOUR_KEY]);
    const log = await watchedLogger();
    const { push, calls } = recordingPush();
    const stop = scheduleRoundPush({
      db: ctx.client,
      logger: log.logger,
      now: () => new Date(),
      push,
    });
    try {
      await log.until("round push not armed", 1);
      expect(log.lines().find((line) => line.msg === "round push not armed")).toMatchObject({
        job: "round-push",
        level: 50,
      });
      await vi.advanceTimersByTimeAsync(HOUR - 1);
      expect(log.lines().filter((line) => line.msg === "round push not armed")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await log.until("round push not armed", 2);
      // 08:00 in Helsinki: the row is back, and the next try arms to 09:00.
      await withMatchingConfig(ctx.client, { [ROUND_PUSH_HOUR_KEY]: 9 });
      await vi.advanceTimersByTimeAsync(HOUR);
      await log.until("round push armed", 1);
      expect(log.armed()).toEqual([HOUR]);
      await vi.advanceTimersByTimeAsync(HOUR);
      await log.until("round push done", 1);
      expect(calls).toHaveLength(1);
    } finally {
      stop();
    }
  });

  test("an hour that is no hour of the day is not armed: logged, and tried again an hour later", async ({
    ctx,
  }) => {
    vi.useFakeTimers({ now: new Date("2026-10-16T04:00:00.000Z"), toFake: [...FAKE.toFake] });
    await withMatchingConfig(ctx.client, { [ROUND_PUSH_HOUR_KEY]: 24 });
    const log = await watchedLogger();
    const { push, calls } = recordingPush();
    const stop = scheduleRoundPush({
      db: ctx.client,
      logger: log.logger,
      now: () => new Date(),
      push,
    });
    try {
      await log.until("round push not armed", 1);
      expect(log.lines().filter((l) => l.msg === "round push not armed")).toEqual([
        expect.objectContaining({
          job: "round-push",
          level: 50,
          err: expect.objectContaining({ detail: { key: ROUND_PUSH_HOUR_KEY } }),
        }),
      ]);
      expect(log.armed()).toEqual([]);
      // 08:00 in Helsinki, the hour a real one again: the next try arms to 09:00.
      await withMatchingConfig(ctx.client, { [ROUND_PUSH_HOUR_KEY]: 9 });
      await vi.advanceTimersByTimeAsync(HOUR);
      await log.until("round push armed", 1);
      expect(log.armed()).toEqual([HOUR]);
      await vi.advanceTimersByTimeAsync(HOUR);
      await log.until("round push done", 1);
      expect(calls).toHaveLength(1);
    } finally {
      stop();
    }
  });

  test("stopped while it waits to try the hour again, it tries no more", async ({ ctx }) => {
    vi.useFakeTimers({ now: new Date("2026-10-16T03:00:00.000Z"), toFake: [...FAKE.toFake] });
    await ctx.client.query("DELETE FROM matching_config WHERE key = $1", [ROUND_PUSH_HOUR_KEY]);
    const log = await watchedLogger();
    const { push, calls } = recordingPush();
    const stop = scheduleRoundPush({
      db: ctx.client,
      logger: log.logger,
      now: () => new Date(),
      push,
    });
    await log.until("round push not armed", 1);
    stop();
    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(log.lines().filter((line) => line.msg === "round push not armed")).toHaveLength(1);
    expect(calls).toEqual([]);
  });
});
