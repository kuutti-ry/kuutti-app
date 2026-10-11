import { afterEach, describe, expect, it, vi } from "vitest";
import { captureLogger } from "../test/harness.ts";
import { msUntilNightly, runNightly, scheduleNightly } from "./nightly.ts";

describe("nightly jobs", () => {
  it("waits until the next 04:00 in Helsinki", () => {
    // Summer time: 04:00 Helsinki is 01:00 UTC.
    expect(msUntilNightly(new Date("2026-07-01T00:00:00Z"))).toBe(60 * 60 * 1000);
    expect(msUntilNightly(new Date("2026-07-01T01:00:00Z"))).toBe(24 * 60 * 60 * 1000);
    expect(msUntilNightly(new Date("2026-07-01T01:00:01Z"))).toBe(24 * 60 * 60 * 1000 - 1000);
    // Winter time: 04:00 Helsinki is 02:00 UTC.
    expect(msUntilNightly(new Date("2026-12-01T00:30:00Z"))).toBe(90 * 60 * 1000);
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
