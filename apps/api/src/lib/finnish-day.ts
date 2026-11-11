/**
 * The Finnish calendar day of an instant, as `YYYY-MM-DD`: the day a person in
 * Finland would say it is, whatever the server's clock zone. For figures that
 * are taken once a day and named by their day (#54); budgets that need the
 * day's bounds use `dayWindow` in the media slice.
 */
export function finnishDay(at: Date): string {
  // en-CA formats as YYYY-MM-DD; the time zone does the rest.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Helsinki",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** A Finnish day `days` after another, both as `YYYY-MM-DD`; before it, for a negative number. */
export function addDays(day: string, days: number): string {
  const at = new Date(`${day}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** The hour of an instant in Finland, 0 to 23: the quiet hours (ADR-055 §7). */
export function finnishHour(at: Date): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Helsinki",
    hour: "numeric",
    hour12: false,
  }).format(at);
  // en-GB writes midnight as 00; % 24 keeps a 24 from any engine at 0.
  return Number(hour) % 24;
}

/** An hour in milliseconds. */
export const HOUR_MS = 60 * 60 * 1000;

/**
 * 24 hours in milliseconds: a day as the counts and windows here measure it,
 * in SQL as in JS, whatever summer time does. Not a Finnish calendar day,
 * which is 23 or 25 hours when the clocks change (`finnishDay`).
 */
export const DAY_MS = 24 * HOUR_MS;

/**
 * Milliseconds from `now` to the next `hour`:00 Europe/Helsinki, whatever the
 * clocks did between: the night's jobs and a push's time to live (#102, ADR-055
 * §7).
 */
export function msUntilFinnishHour(now: Date, hour: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Helsinki",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const sinceMidnight = ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000;
  const target = hour * 3600 * 1000;
  const counted =
    target - sinceMidnight > 0 ? target - sinceMidnight : target - sinceMidnight + DAY_MS;
  // The count is the wall clock's, which a change of clocks between now and
  // then moves an hour against the real one (the last Sundays of March and
  // October): the hour the counted instant shows in Helsinki says by how
  // much. An hour the change skips (03:00 in March) keeps the count.
  const drift = (finnishHour(new Date(now.getTime() + counted)) - hour + 24) % 24;
  const corrected = drift === 1 ? counted - HOUR_MS : drift === 23 ? counted + HOUR_MS : counted;
  return corrected > 0 && finnishHour(new Date(now.getTime() + corrected)) === hour
    ? corrected
    : counted;
}
