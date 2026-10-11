import type { Queryable } from "@kuutti/db";
import { PhotoFetchBudget } from "@kuutti/schema";
import { AppError } from "../lib/errors.ts";
import { readMatchingConfig } from "../lib/matching-config.ts";

// The exposure budget's day (#52, TD-6, ADR-008). The count itself happens in
// the statement that writes the fetch-log row (repo.insertPhotoAccess), so
// two requests cannot both pass a separate count; what lives here is the day
// the count is over and the wait a refusal announces.

export const PHOTO_FETCHES_KEY = "photo_fetches_per_day";

/** Kuutti is for Finland: the day rolls at midnight in Helsinki, DST included. */
export const DAY_TIME_ZONE = "Europe/Helsinki";

export type DayWindow = { start: Date; end: Date };

/** The calendar day of `at` in the zone, as [local midnight, next local midnight). */
export function dayWindow(at: Date, timeZone: string = DAY_TIME_ZONE): DayWindow {
  const { year, month, day } = localParts(at, timeZone);
  return {
    start: zonedMidnight(year, month, day, timeZone),
    end: zonedMidnight(year, month, day + 1, timeZone),
  };
}

/** The year and month it is in Finland at `at`: the age on the card counts from them (rule 3, #47). */
export function localYearMonth(
  at: Date,
  timeZone: string = DAY_TIME_ZONE,
): { year: number; month: number } {
  const { year, month } = localParts(at, timeZone);
  return { year, month };
}

/** Whole seconds until the window ends, at least one: the Retry-After of a refusal. */
export function secondsUntil(end: Date, now: Date): number {
  return Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 1000));
}

export async function readPhotoFetchBudget(db: Queryable): Promise<PhotoFetchBudget> {
  const value = await readMatchingConfig(db, PHOTO_FETCHES_KEY);
  const parsed = PhotoFetchBudget.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      500,
      "internal_error",
      `matching_config ${PHOTO_FETCHES_KEY} is not a budget per variant`,
      { key: PHOTO_FETCHES_KEY },
    );
  }
  return parsed.data;
}

type Parts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function localParts(at: Date, timeZone: string): Parts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/**
 * The instant of local midnight on a date (the day may overflow the month;
 * Date.UTC normalises it). Start from the same wall-clock time read as UTC
 * and move the guess by the difference between the wall clock it shows in the
 * zone and the one wanted; a second pass settles the one case where the
 * first guess lands on the other side of a DST change.
 */
function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const wanted = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = wanted;
  for (let pass = 0; pass < 2; pass += 1) {
    const local = localParts(new Date(guess), timeZone);
    const shown = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    guess += wanted - shown;
  }
  return new Date(guess);
}
