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

/** The hour of an instant in Finland, 0 to 23: the quiet hours and the round's push (ADR-055 §6, §7). */
export function finnishHour(at: Date): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Helsinki",
    hour: "numeric",
    hour12: false,
  }).format(at);
  // en-GB writes midnight as 00; % 24 keeps a 24 from any engine at 0.
  return Number(hour) % 24;
}
