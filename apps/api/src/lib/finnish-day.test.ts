import { describe, expect, it } from "vitest";
import { addDays, finnishDay, finnishHour } from "./finnish-day.ts";

describe("finnishDay", () => {
  it("names the day in Finland, not the server's", () => {
    // 22:30 UTC is already the next day in Helsinki, summer and winter.
    expect(finnishDay(new Date("2026-06-30T22:30:00Z"))).toBe("2026-07-01");
    expect(finnishDay(new Date("2026-12-31T22:30:00Z"))).toBe("2027-01-01");
    expect(finnishDay(new Date("2026-09-27T12:00:00Z"))).toBe("2026-09-27");
    // Winter time is UTC+2: 21:30 UTC is still the same day.
    expect(finnishDay(new Date("2026-12-31T21:30:00Z"))).toBe("2026-12-31");
  });
});

// The ladder's clocks and the year's prune count days by the calendar (ADR-062 §6, §13).
describe("addDays", () => {
  it.each([
    ["2026-11-01", 0, "2026-11-01"],
    ["2026-11-01", 1, "2026-11-02"],
    ["2026-11-01", -1, "2026-10-31"],
    // Across a month and a year, a leap day among them.
    ["2026-12-31", 1, "2027-01-01"],
    ["2028-02-28", 1, "2028-02-29"],
    ["2028-03-01", -1, "2028-02-29"],
    ["2026-02-28", 1, "2026-03-01"],
    // The days of 25 and 23 hours are one day each.
    ["2026-10-24", 2, "2026-10-26"],
    ["2027-03-27", 2, "2027-03-29"],
    // The longest clock.
    ["2026-11-01", -365, "2025-11-01"],
  ])("%s and %i days is %s", (day, days, expected) => {
    expect(addDays(day, days)).toBe(expected);
  });
});

// The hour the quiet hours read (#102, ADR-055 §7).
describe("finnishHour", () => {
  it.each([
    // Summer time, UTC+3: midnight in Helsinki is 21:00 UTC.
    ["2026-06-30T20:59:59.999Z", 23],
    ["2026-06-30T21:00:00.000Z", 0],
    ["2026-06-30T21:59:59.999Z", 0],
    ["2026-06-30T22:00:00.000Z", 1],
    // Winter time, UTC+2: midnight is 22:00 UTC.
    ["2026-12-31T21:59:59.999Z", 23],
    ["2026-12-31T22:00:00.000Z", 0],
    // Noon, either way.
    ["2026-07-15T09:00:00.000Z", 12],
    ["2026-01-15T10:00:00.000Z", 12],
    // The quiet hours' bounds, 22 and 8, in summer.
    ["2026-07-15T18:59:59.000Z", 21],
    ["2026-07-15T19:00:00.000Z", 22],
    ["2026-07-15T04:59:59.000Z", 7],
    ["2026-07-15T05:00:00.000Z", 8],
  ])("%s is %i o'clock in Helsinki", (at, hour) => {
    expect(finnishHour(new Date(at))).toBe(hour);
  });

  it("skips three o'clock when summer time begins, 29 March 2026", () => {
    // At 01:00 UTC the clocks go from 03:00 to 04:00.
    expect(finnishHour(new Date("2026-03-29T00:59:59Z"))).toBe(2);
    expect(finnishHour(new Date("2026-03-29T01:00:00Z"))).toBe(4);
    const hours = Array.from({ length: 24 }, (_, h) =>
      finnishHour(new Date(Date.UTC(2026, 2, 28, 22 + h))),
    );
    expect(hours).toEqual([
      0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0,
    ]);
  });

  it("has three o'clock twice when summer time ends, 25 October 2026", () => {
    // At 01:00 UTC the clocks go back from 04:00 to 03:00.
    expect(finnishHour(new Date("2026-10-25T00:30:00Z"))).toBe(3);
    expect(finnishHour(new Date("2026-10-25T00:59:59Z"))).toBe(3);
    expect(finnishHour(new Date("2026-10-25T01:00:00Z"))).toBe(3);
    expect(finnishHour(new Date("2026-10-25T01:30:00Z"))).toBe(3);
    expect(finnishHour(new Date("2026-10-25T02:00:00Z"))).toBe(4);
  });

  it("reads the hour of the Finnish day, which is not the UTC date's", () => {
    // 22:30 UTC on 1 July is 01:30 on 2 July in Helsinki.
    const at = new Date("2026-07-01T22:30:00Z");
    expect(at.getUTCHours()).toBe(22);
    expect(finnishHour(at)).toBe(1);
    expect(finnishDay(at)).toBe("2026-07-02");
  });
});
