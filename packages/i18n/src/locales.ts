/** Locales with a catalogue. English is the source; fi and sv fall back to it (TD-17). */
export const LOCALES = ["en", "fi", "sv", "fi-x-stadi"] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * Made-up languages, each with the real language it falls back to (#521).
 * `fi-x-stadi` is Stadin slangi, a joke beside the three real languages, under
 * a BCP 47 private-use tag that no phone or browser asks for: a person picks it
 * in the app. A key with no `slangi:` text in messages.yaml is the Finnish
 * text. It stays out of RELEASED_LOCALES.
 */
export const FICTIONAL_LOCALES = { "fi-x-stadi": "fi" } as const satisfies Partial<
  Record<Locale, Locale>
>;

/** A language that exists outside the app: what a bank, a consent record or Intl can be told. */
export type RealLocale = Exclude<Locale, keyof typeof FICTIONAL_LOCALES>;

/** Accented, elongated, bracketed English: shows clipped and concatenated text in dev builds. */
export const PSEUDO_LOCALE = "en-XA";
export type AnyLocale = Locale | typeof PSEUDO_LOCALE;

export const DEFAULT_LOCALE: Locale = "en";

/**
 * The languages a release ships (#55, TD-17): English and Finnish at launch.
 * `pnpm i18n:check --release` holds each of them to a native review; Swedish
 * waits in dev and staging, where a reviewer can read it, until one has cleared
 * it, and releasing it is adding it here. A production build of the app and
 * the production API pass it as `allowed` to resolveLocale; every other
 * environment serves all the catalogues.
 */
export const RELEASED_LOCALES = ["en", "fi"] as const satisfies readonly Locale[];

/** Each language under its own name, which is how a language picker lists them; never translated. */
export const LOCALE_NAMES: Record<AnyLocale, string> = {
  en: "English",
  fi: "Suomi",
  sv: "Svenska",
  "fi-x-stadi": "Stadi",
  "en-XA": "［Pseudo］",
};

/**
 * The real language a locale reads as, for whatever cannot take a made-up one:
 * the bank's chooser, a consent record, a country's name, a pond's case forms.
 * The pseudo-locale and anything that is not ours read English.
 */
export function realLocale(locale: string): RealLocale {
  if (locale === "fi-x-stadi") return FICTIONAL_LOCALES[locale];
  return locale === "fi" || locale === "sv" ? locale : "en";
}

/**
 * The first preference we have a catalogue for, by language ("fi-FI" and "fi"
 * are both Finnish, and so is a request naming fi-x-stadi: nothing the API
 * says is in slang), else English. Input is a list of BCP 47 tags in order of
 * preference: the device's locales, or a parsed Accept-Language header.
 * `allowed` narrows the catalogues on offer, to RELEASED_LOCALES in production,
 * and the answer is always one of them: English when it is allowed, else the
 * first allowed locale. An empty list is a programming error.
 */
export function resolveLocale(
  preferences: readonly string[],
  allowed: readonly Locale[] = LOCALES,
): Locale {
  const [first] = allowed;
  if (first === undefined) throw new Error("resolveLocale needs at least one allowed locale");
  for (const tag of preferences) {
    const language = tag.trim().toLowerCase().split(/[-_]/)[0] ?? "";
    const match = allowed.find((locale) => locale === language);
    if (match) return match;
  }
  return allowed.includes(DEFAULT_LOCALE) ? DEFAULT_LOCALE : first;
}

const MAX_ACCEPT_LANGUAGE_LENGTH = 256;

/** Language tags of an Accept-Language header, most preferred first; q=0 means "not this one". */
export function parseAcceptLanguage(header: string | undefined | null): string[] {
  if (!header) return [];
  // A real header is a few dozen bytes. The cap bounds the work a hostile one
  // can ask for, since this runs before the rate limiter.
  return header
    .slice(0, MAX_ACCEPT_LANGUAGE_LENGTH)
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
      const weight = q === undefined ? 1 : Number(q);
      return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter(({ tag, weight }) => tag.length > 0 && tag !== "*" && weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map(({ tag }) => tag);
}
