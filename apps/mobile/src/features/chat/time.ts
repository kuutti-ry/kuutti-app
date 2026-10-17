import { type AnyLocale, formatDate, formatTime } from "@kuutti/i18n";

/** Finland's clock: a message's day and time are the same for both people, wherever a phone was set. */
const HELSINKI = { timeZone: "Europe/Helsinki" };

/** The day of an instant, d.M.yyyy (#150): what a day separator says. */
export const dayOf = (locale: AnyLocale, at: string | Date): string =>
  formatDate(locale, new Date(at), HELSINKI);

export const timeOf = (locale: AnyLocale, at: string | Date): string =>
  formatTime(locale, new Date(at), HELSINKI);

/** The time for a message of today, the day for an older one: what a row of the list shows. */
export const whenOf = (locale: AnyLocale, at: string, now: Date = new Date()): string =>
  dayOf(locale, at) === dayOf(locale, now) ? timeOf(locale, at) : dayOf(locale, at);
