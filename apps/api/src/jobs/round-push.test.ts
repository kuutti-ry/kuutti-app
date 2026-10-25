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
import { ROUND_PUSH_HOUR_KEY, runRoundPush, scheduleRoundPush } from "./round-push.ts";

// The round's push (#102, ADR-055 §6, features/notifications/push.feature):
// whom one run tells, on the real database in the harness's transaction with
// rounds written as the builder writes them, and the timer around it, on
// vitest's fake clock, waiting on what it logs, never on a sleep.

/** 12:00 in Helsinki, a Friday in summer time (UTC+3): midnight is twelve hours away. */
const T = new Date("2026-10-16T09:00:00.000Z");
const HOUR = 60 * 60 * 1000;
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
        // Twelve hours to midnight in Helsinki.
        ttl: 12 * 60 * 60,
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

  test("lives until the Finnish day ends, a minute at least", async ({ ctx }) => {
    const [owner, card] = await people(ctx.client, null, 2, { complete: true });
    if (!owner || !card) throw new Error("no people");
    await deviceOf(ctx.client, owner);
    // No quiet hours, so the evening can be told.
    await withMatchingConfig(ctx.client, { push_quiet_from_hour: 0, push_quiet_to_hour: 0 });
    const cases: Array<[string, number]> = [
      // 12:00 in summer time: twelve hours.
      ["2026-10-16T09:00:00.000Z", 12 * 3600],
      // 23:58 in Helsinki: two minutes.
      ["2026-10-16T20:58:00.000Z", 120],
      // 23:59:30: thirty seconds, given a minute.
      ["2026-10-16T20:59:30.000Z", 60],
      // 12:00 on the day summer time ends, now UTC+2: twelve hours to its midnight.
      ["2026-10-25T10:00:00.000Z", 12 * 3600],
      // 12:00 in winter, on a day that is not T's.
      ["2026-12-01T10:00:00.000Z", 12 * 3600],
    ];
    for (const [at, ttl] of cases) {
      const when = new Date(at);
      await ctx.client.query("DELETE FROM rounds WHERE account_id = $1", [owner]);
      await roundOf(ctx.client, owner, [card], when);
      const { deps, pusher } = await pushAt(ctx, when);
      expect(await runRoundPush(deps), at).toEqual({ rounds: 1, pushed: 1 });
      expect(pusher.sent()[0]?.ttl, at).toBe(ttl);
    }
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
  const calls: Array<{ at: string; day: string; accountIds: readonly string[]; ttl: number }> = [];
  const push: Push = {
    message: async () => {},
    match: async () => {},
    round: async (accountIds, ttl) => {
      const at = new Date();
      calls.push({ at: at.toISOString(), day: finnishDay(at), accountIds, ttl });
      if (fail(calls.length)) throw new Error("push broke");
      return accountIds.length;
    },
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
        { at: "2026-10-16T06:00:00.000Z", day: "2026-10-16", accountIds: [owner], ttl: 15 * 3600 },
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

  test("logs a run that fails, survives it, and runs again the next day", async ({ ctx }) => {
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
      await vi.advanceTimersByTimeAsync(60 * 1000);
      await log.until("round push armed", 2);
      expect(log.lines().filter((line) => line.msg === "round push failed")).toEqual([
        expect.objectContaining({ job: "round-push", level: 50 }),
      ]);
      // The day failed is not tried again; the next one is told.
      expect(log.armed()[1]).toBe(DAY);
      await vi.advanceTimersByTimeAsync(DAY);
      await log.until("round push done", 1);
      expect(calls.map((call) => call.day)).toEqual(["2026-10-16", "2026-10-17"]);
    } finally {
      stop();
    }
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
