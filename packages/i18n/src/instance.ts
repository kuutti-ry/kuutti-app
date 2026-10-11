import i18next, { type i18n } from "i18next";
import ICU from "i18next-icu";
import { intlLocale } from "./format.ts";
import { en } from "./generated/en.ts";
import { fi } from "./generated/fi.ts";
import type { MessageKey, MessageParams } from "./generated/keys.ts";
import { sv } from "./generated/sv.ts";
import { type AnyLocale, DEFAULT_LOCALE, PSEUDO_LOCALE } from "./locales.ts";

/** Keys with ICU arguments demand them; keys without take none. */
type ParamsOf<K extends MessageKey> = keyof MessageParams[K] extends never
  ? []
  : [params: MessageParams[K]];

/** Keys that take no arguments: what a table of labels may hold and pass to t() as is. */
export type PlainMessageKey = {
  [K in MessageKey]: keyof MessageParams[K] extends never ? K : never;
}[MessageKey];

/** `t("onboarding.retry")`, `t("errors.rate_limited", { seconds: 3 })`; an unknown key is a type error. */
export type TFunction = <K extends MessageKey>(key: K, ...params: ParamsOf<K>) => string;

export type CreateI18nOptions = {
  locale: AnyLocale;
  /**
   * The en-XA catalogue from `@kuutti/i18n/pseudo`, handed in by a dev build.
   * It is a separate entry so a production bundle never carries it.
   */
  pseudo?: Readonly<Record<string, string>>;
  /** Extra i18next plugins: initReactI18next on the clients. */
  plugins?: Parameters<i18n["use"]>[0][];
};

/**
 * An i18next instance over the compiled catalogues with ICU MessageFormat.
 * Keys are flat ("home.title"), fi and sv fall back to en, and init is
 * synchronous because every catalogue is already in the bundle.
 */
export function createI18n(options: CreateI18nOptions): i18n {
  const instance = i18next.createInstance();
  instance.use(ICU);
  for (const plugin of options.plugins ?? []) instance.use(plugin);
  void instance.init({
    lng: options.locale,
    // ICU dates and numbers in Finland's locale for every language (format.ts).
    i18nFormat: { parseLngForICU: intlLocale },
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: options.pseudo ? ["en", "fi", "sv", PSEUDO_LOCALE] : ["en", "fi", "sv"],
    resources: {
      en: { translation: en },
      fi: { translation: fi },
      sv: { translation: sv },
      ...(options.pseudo ? { [PSEUDO_LOCALE]: { translation: options.pseudo } } : {}),
    },
    keySeparator: false,
    nsSeparator: false,
    initAsync: false,
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return instance;
}

/** The typed face of an instance, optionally fixed to one locale (the API, per request). */
export function typedT(instance: i18n, locale?: AnyLocale): TFunction {
  const t = locale ? instance.getFixedT(locale) : instance.t.bind(instance);
  return ((key: string, params?: Record<string, unknown>) =>
    t(key, params as Record<string, unknown>)) as TFunction;
}
