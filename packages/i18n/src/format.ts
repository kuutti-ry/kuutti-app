import type { AnyLocale } from "./locales.ts";
import { PSEUDO_LOCALE } from "./locales.ts";

/**
 * The Intl locale for a catalogue locale: Finland's, in every language. Bare
 * `en` is the United States (9/20/26, 5:14 PM) and bare `sv` is Sweden
 * (2026-09-20); `en-FI` and `sv-FI` are Finland's conventions (24-hour time,
 * space-grouped numbers with a decimal comma). The pseudo-locale has no Intl
 * data; it is English with odd letters.
 */
export function intlLocale(locale: AnyLocale | string): string {
  switch (locale) {
    case "en":
    case PSEUDO_LOCALE:
      return "en-FI";
    case "sv":
      return "sv-FI";
    default:
      return locale;
  }
}

/** The one option a caller may pass: tests pin the zone, screens take the device's. */
export type FormatOptions = { timeZone?: string };

/**
 * A date as the field sheet writes it: d.M.yyyy, the same in every language
 * (#150, the sheet's "Formats" line). Never ISO, never month first, never a
 * month name: 19.9.2026 reads the same to a Finnish, Swedish and English
 * reader in Finland. The Finnish numeric pattern is that format, so every
 * language goes through it, still through Intl, never string building.
 */
export function formatDate(
  _locale: AnyLocale,
  value: Date | number,
  options: FormatOptions = {},
): string {
  return new Intl.DateTimeFormat("fi-FI", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    timeZone: options.timeZone,
  }).format(value);
}

/** A time of day in Finland's convention for the language: 24 hours, the language's own separator (14.14). */
export function formatTime(
  locale: AnyLocale,
  value: Date | number,
  options: FormatOptions = {},
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: options.timeZone,
  }).format(value);
}

/**
 * A date with its time: the date of formatDate, the time of formatTime,
 * joined with a space. Composed rather than one Intl call because English
 * Intl has no d.M.yyyy of its own, and the sheet wants that order everywhere.
 */
export function formatDateTime(
  locale: AnyLocale,
  value: Date | number,
  options: FormatOptions = {},
): string {
  return `${formatDate(locale, value, options)} ${formatTime(locale, value, options)}`;
}

export function formatNumber(
  locale: AnyLocale,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(intlLocale(locale), options).format(value);
}

/** A height on a card and under its field: centimetres with the unit, the number through Intl, a non-breaking space before the unit (#150). */
export function formatHeight(locale: AnyLocale, cm: number): string {
  return `${formatNumber(locale, cm, { maximumFractionDigits: 0 })} cm`;
}

/** The grammatical cases a pond's name is stored in (#4: `ponds.name_inessive`). */
export type PondCase = "nominative" | "inessive";

/**
 * A pond as the API hands it over (`PondSummary` in packages/schema): the name
 * in every case form a sentence may need. Every form is required, so a caller
 * that drops one is a type error instead of a sentence silently back in the
 * nominative (#55).
 */
export type PondName = { name: string; nameInessive: string };

/**
 * A pond's name in the case a sentence needs, read from the stored form and
 * never built: Finnish inflects proper nouns irregularly ("Helsinki",
 * "Helsingissä"), so TD-17 stores each form per pond. English and Swedish
 * use the nominative.
 */
export function formatPond(pond: PondName, grammaticalCase: PondCase, locale: AnyLocale): string {
  if (locale === "fi" && grammaticalCase === "inessive") return pond.nameInessive;
  return pond.name;
}
