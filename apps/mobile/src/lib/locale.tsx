// First, before anything formats a message: what Hermes lacks of Intl.
import "./intl-polyfill";
import {
  type AnyLocale,
  LOCALES,
  type Locale,
  PSEUDO_LOCALE,
  RELEASED_LOCALES,
  resolveLocale,
} from "@kuutti/i18n";
import { createReactI18n, I18nProvider, useT } from "@kuutti/i18n/react";
import { useLocales } from "expo-localization";
import * as React from "react";
import { isProduction } from "./environment";
import { readPreference, writePreference } from "./preferences";

/** "system" follows the phone; anything else is the user's own choice and beats it (#13). */
export type LocalePreference = "system" | AnyLocale;

// The pseudo-locale is a separate entry so that only a dev build bundles it.
const pseudo: Readonly<Record<string, string>> | undefined = __DEV__
  ? (require("@kuutti/i18n/pseudo") as typeof import("@kuutti/i18n/pseudo")).enXA
  : undefined;

/**
 * The catalogues this build serves: a production build only the released
 * languages, so text that is still machine text is never shown there; every
 * other channel all of them, so a reviewer reads Swedish on staging before it
 * is released (#55, TD-17).
 */
export const SERVED_LOCALES: readonly Locale[] = isProduction() ? RELEASED_LOCALES : LOCALES;

/** What the language picker offers: the served catalogues, and en-XA in dev builds. */
export const OFFERED_LOCALES: readonly AnyLocale[] = pseudo
  ? [...SERVED_LOCALES, PSEUDO_LOCALE]
  : SERVED_LOCALES;

/**
 * The flag shown next to each language in the picker. A language is not a
 * country, so each flag is where Kuutti's users speak it: Finland, Britain
 * for English, and Åland for Swedish (the Swedish of Finland, not Sweden; the
 * team's choice). Decorative: the accessible name stays the language's name.
 */
export const LOCALE_FLAGS: Readonly<Record<AnyLocale, string>> = {
  en: "🇬🇧",
  fi: "🇫🇮",
  sv: "🇦🇽",
  "en-XA": "",
};

const isOffered = (value: string | null): value is AnyLocale =>
  value !== null && (OFFERED_LOCALES as readonly string[]).includes(value);

type LocaleSettings = {
  preference: LocalePreference;
  setPreference: (preference: LocalePreference) => void;
  /** The phone's language, resolved to a catalogue. */
  deviceLocale: Locale;
};

const LocaleSettingsContext = React.createContext<LocaleSettings | null>(null);

/**
 * The app's language: the stored override if there is one, else the phone's
 * first language that has a catalogue, else English (fi and sv also fall back
 * to English per key). Changing either re-renders every useT().
 */
export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const deviceLocale = resolveLocale(
    useLocales().map((locale) => locale.languageTag),
    SERVED_LOCALES,
  );
  const [preference, setPreferenceState] = React.useState<LocalePreference>("system");
  const [i18n] = React.useState(() => createReactI18n({ locale: deviceLocale, pseudo }));

  React.useEffect(() => {
    let mounted = true;
    void readPreference("locale").then((stored) => {
      if (mounted && isOffered(stored)) setPreferenceState(stored);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const effective = preference === "system" ? deviceLocale : preference;
  React.useEffect(() => {
    if (i18n.language !== effective) void i18n.changeLanguage(effective);
  }, [i18n, effective]);

  const settings = React.useMemo<LocaleSettings>(
    () => ({
      preference,
      deviceLocale,
      setPreference: (next) => {
        setPreferenceState(next);
        void writePreference("locale", next === "system" ? null : next);
      },
    }),
    [preference, deviceLocale],
  );

  return (
    <LocaleSettingsContext.Provider value={settings}>
      <I18nProvider i18n={i18n}>{children}</I18nProvider>
    </LocaleSettingsContext.Provider>
  );
}

export function useLocaleSettings(): LocaleSettings {
  const settings = React.useContext(LocaleSettingsContext);
  if (!settings) throw new Error("useLocaleSettings needs a LocaleProvider above it");
  return settings;
}

export { useT };
