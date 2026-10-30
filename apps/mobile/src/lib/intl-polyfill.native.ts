// Hermes ships Intl.NumberFormat and Intl.DateTimeFormat but not Intl.Locale,
// Intl.PluralRules or Intl.DisplayNames (checked on iOS, RN 0.86); ICU plurals
// need the first two: without them the first `{count, plural, ...}` on a phone throws
// MISSING_INTL_API. Each polyfill installs itself only where the API is
// missing; plural data is loaded for the locales that have a catalogue (#13).
import "@formatjs/intl-locale/polyfill.js";
// Country names for the phone number's code (#511), in the app's three languages.
import "@formatjs/intl-displaynames/polyfill.js";
import "@formatjs/intl-displaynames/locale-data/en.js";
import "@formatjs/intl-displaynames/locale-data/fi.js";
import "@formatjs/intl-displaynames/locale-data/sv.js";
import "@formatjs/intl-pluralrules/polyfill.js";
import "@formatjs/intl-pluralrules/locale-data/en.js";
import "@formatjs/intl-pluralrules/locale-data/fi.js";
import "@formatjs/intl-pluralrules/locale-data/sv.js";
