import { afterEach, describe, expect, it, vi } from "vitest";
import { captureLogger } from "../test/harness.ts";
import { msUntilFinnishHour, msUntilNightly, runNightly, scheduleNightly } from "./nightly.ts";

describe("nightly jobs", () => {
  it("waits until the next 04:00 in Helsinki", () => {
    // Summer time: 04:00 Helsinki is 01:00 UTC.
    expect(msUntilNightly(new Date("2026-07-01T00:00:00Z"))).toBe(60 * 60 * 1000);
    expect(msUntilNightly(new Date("2026-07-01T01:00:00Z"))).toBe(24 * 60 * 60 * 1000);
    expect(msUntilNightly(new Date("2026-07-01T01:00:01Z"))).toBe(24 * 60 * 60 * 1000 - 1000);
    // Winter time: 04:00 Helsinki is 02:00 UTC.
    expect(msUntilNightly(new Date("2026-12-01T00:30:00Z"))).toBe(90 * 60 * 1000);
  });

  it("waits until 04:00 as it did before the hour was a parameter (#102)", () => {
    for (const at of [
      "2026-07-01T00:00:00Z",
      "2026-07-01T01:00:00Z",
      "2026-07-01T01:00:01Z",
      "2026-12-01T00:30:00Z",
      "2026-12-01T23:59:59Z",
    ]) {
      expect(msUntilNightly(new Date(at)), at).toBe(msUntilFinnishHour(new Date(at), 4));
    }
    expect(msUntilNightly(new Date("2026-12-01T01:59:59Z"))).toBe(1000);
  });

  it("runs every job and logs a failure without stopping the rest", async () => {
    const { logger, lines } = await captureLogger();
    const ran: string[] = [];
    await runNightly(
      [
        { name: "first", run: async () => ({ rows: 1 }) },
        {
          name: "broken",
          run: async () => {
            throw new Error("boom");
          },
        },
        {
          name: "last",
          run: async () => {
            ran.push("last");
            return {};
          },
        },
      ],
      logger,
    );
    expect(ran).toEqual(["last"]);
    const msgs = lines().map((l) => `${l.job}:${l.msg}`);
    expect(msgs).toEqual([
      "first:nightly job done",
      "broken:nightly job failed",
      "last:nightly job done",
    ]);
  });
});

// The wait the round's push is armed with (#102, ADR-055 §6), and the night's.
describe("msUntilFinnishHour", () => {
  const SECOND = 1000;
  const DAY = 24 * 60 * 60 * SECOND;
  it.each([
    // Summer time, UTC+3: 00:00 Helsinki is 21:00 UTC the day before.
    [0, "2026-07-01T20:59:59Z", SECOND],
    [0, "2026-07-01T21:00:00Z", DAY],
    [0, "2026-07-01T21:00:01Z", DAY - SECOND],
    // 09:00 Helsinki is 06:00 UTC.
    [9, "2026-07-02T05:59:59Z", SECOND],
    [9, "2026-07-02T06:00:00Z", DAY],
    [9, "2026-07-02T06:00:01Z", DAY - SECOND],
    // 23:00 Helsinki is 20:00 UTC.
    [23, "2026-07-02T19:59:59Z", SECOND],
    [23, "2026-07-02T20:00:00Z", DAY],
    [23, "2026-07-02T20:00:01Z", DAY - SECOND],
    // Winter time, UTC+2: 09:00 Helsinki is 07:00 UTC.
    [9, "2026-12-02T06:59:59Z", SECOND],
    [9, "2026-12-02T07:00:00Z", DAY],
    [9, "2026-12-02T07:00:01Z", DAY - SECOND],
    // From the far side of the day: 09:00 the next morning.
    [9, "2026-12-02T21:00:00Z", 10 * 60 * 60 * SECOND],
  ])("for %i o'clock from %s waits %i ms", (hour, at, wait) => {
    expect(msUntilFinnishHour(new Date(at), hour)).toBe(wait);
  });

  it.each([
    // Summer time ends on 25 October 2026 at 04:00 EEST (01:00 UTC): the night
    // is 04:00 EET, 02:00 UTC, and the round's push 09:00 EET, 07:00 UTC.
    [4, "2026-10-24T22:00:00Z", 4 * 60 * 60 * SECOND],
    [9, "2026-10-24T06:00:00Z", DAY + 60 * 60 * SECOND],
    // Summer time begins on 29 March 2026 at 03:00 EET (01:00 UTC): the night
    // is 04:00 EEST, 01:00 UTC, and the round's push 09:00 EEST, 06:00 UTC.
    [4, "2026-03-28T23:00:00Z", 2 * 60 * 60 * SECOND],
    [9, "2026-03-28T07:00:00Z", DAY - 60 * 60 * SECOND],
    // 03:00 does not happen that night: the count stands, and lands at 04:00.
    [3, "2026-03-28T23:00:00Z", 2 * 60 * 60 * SECOND],
  ])(
    "for %i o'clock from %s across a change of clocks waits %i ms, landing on the hour",
    (hour, at, wait) => {
      expect(msUntilFinnishHour(new Date(at), hour)).toBe(wait);
    },
  );

  it("leaves out a fraction of a second, so a timer is late by it and never early", () => {
    // 08:59:59.500 in Helsinki: the second's half is not counted, the timer fires at 09:00:00.500.
    expect(msUntilFinnishHour(new Date("2026-07-02T05:59:59.500Z"), 9)).toBe(SECOND);
    // At 09:00:00.500 the hour has come: the next is a day away.
    expect(msUntilFinnishHour(new Date("2026-07-02T06:00:00.500Z"), 9)).toBe(DAY);
  });
});

describe("scheduleNightly", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the jobs at the next 04:00 in Helsinki, then every 24 hours, until it is stopped", async () => {
    // 03:00 in Helsinki (summer time): the first run is an hour away.
    vi.useFakeTimers({ now: new Date("2026-07-01T00:00:00Z") });
    const { logger, lines } = await captureLogger();
    const runs: string[] = [];
    const job = {
      name: "count",
      run: async () => {
        runs.push(new Date().toISOString());
        return { rows: runs.length };
      },
    };
    const stop = scheduleNightly([job], logger);
    expect(lines().find((l) => l.msg === "nightly jobs armed")).toMatchObject({
      jobs: ["count"],
      inMs: 60 * 60 * 1000,
    });

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 1);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual(["2026-07-01T01:00:00.000Z"]);
    expect(lines().find((l) => l.msg === "nightly job done")).toMatchObject({
      job: "count",
      rows: 1,
    });

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(runs).toEqual(["2026-07-01T01:00:00.000Z", "2026-07-02T01:00:00.000Z"]);

    stop();
    await vi.advanceTimersByTimeAsync(3 * 24 * 60 * 60 * 1000);
    expect(runs).toHaveLength(2);
  });

  it("a job that fails one night is run again the next", async () => {
    vi.useFakeTimers({ now: new Date("2026-12-01T01:59:00Z") });
    const { logger, lines } = await captureLogger();
    let nights = 0;
    const job = {
      name: "flaky",
      run: async () => {
        nights += 1;
        if (nights === 1) throw new Error("database away");
        return {};
      },
    };
    // The clock it is handed decides when the night is: 04:00 Helsinki is 02:00 UTC in winter.
    const stop = scheduleNightly([job], logger, () => new Date());
    await vi.advanceTimersByTimeAsync(60 * 1000);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    stop();
    expect(nights).toBe(2);
    const outcomes = new Set(["nightly job failed", "nightly job done"]);
    expect(
      lines()
        .map((l) => l.msg)
        .filter((m) => outcomes.has(m ?? "")),
    ).toEqual(["nightly job failed", "nightly job done"]);
  });
});
