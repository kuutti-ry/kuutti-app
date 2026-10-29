import {
  type CountryCode,
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
} from "libphonenumber-js/min";

export type Region = CountryCode;

/** The code a number field starts with, whatever the phone's own region: Kuutti's people are in Finland. */
export const HOME_REGION: Region = "FI";

/** The countries listed first in the picker, Finland and its neighbours (an assumption, #511). */
export const NEAR_REGIONS: readonly Region[] = ["FI", "SE", "EE", "NO"];

export type PhoneRead =
  | { e164: string; region: Region }
  | { refused: "short" | "long" | "invalid" };

/**
 * A number as a person types it, read under the country code chosen (#511):
 * with or without the 0 a country dials at home (040 660 1234 and 40 660
 * 1234 alike), with the code written out (+358 40…, 00358 40…, 358 40…,
 * +358 (0)40…), and with spaces, hyphens, dots and brackets anywhere. A full
 * number with another country's code is that country's, and says so in
 * `region`. Letters are never a number here, though phone keypads carry
 * them. The answer is E.164, which the API's own rule (normaliseContact)
 * accepts; a refusal says whether a digit is missing, one too many, or the
 * number is no number under that code.
 *
 * shortcut: libphonenumber-js/min validates by a number's length and first
 * digits, not every range a country has given out; /max metadata, about
 * twice the size, would refuse more and is not needed for a contact the
 * other person reads with their own eyes.
 */
export function readPhone(text: string, region: Region): PhoneRead {
  const raw = text.normalize("NFKC").trim();
  if (/\p{L}/u.test(raw)) return { refused: "invalid" };
  const digits = raw.replace(/\(0\)/g, "").replace(/[\s().\-/]/g, "");
  const written = digits.startsWith("00") ? `+${digits.slice(2)}` : digits;
  const code = getCountryCallingCode(region);
  // The code typed without its plus (358 40…) reads as the code first.
  const candidates =
    !written.startsWith("+") && written.startsWith(code) ? [`+${written}`, written] : [written];
  for (const candidate of candidates) {
    const number = parsePhoneNumberFromString(candidate, region);
    if (number?.isValid()) return { e164: number.number, region: number.country ?? region };
  }
  switch (validatePhoneNumberLength(written, region)) {
    case "TOO_SHORT":
      return { refused: "short" };
    case "TOO_LONG":
      return { refused: "long" };
    default:
      return { refused: "invalid" };
  }
}

/** A stored number shown back in its field (#511): the code beside the field, the rest grouped as its country writes it. */
export function showPhone(e164: string): { region: Region; rest: string } {
  const number = parsePhoneNumberFromString(e164);
  if (!number?.country) return { region: HOME_REGION, rest: e164 };
  const code = `+${number.countryCallingCode}`;
  return { region: number.country, rest: number.formatInternational().slice(code.length).trim() };
}

/** A region's calling code, as the field and the picker show it. */
export const codeOf = (region: Region): string => `+${getCountryCallingCode(region)}`;

/** A region's flag, drawn from its two letters; decoration beside its name. */
const flagOf = (region: Region): string =>
  String.fromCodePoint(...[...region].map((letter) => 0x1f1a5 + letter.charCodeAt(0)));

export type Country = { region: Region; code: string; name: string; english: string; flag: string };

/** Every country a number can have, named in the app's language and in English, in the language's order. */
export function countries(locale: string): Country[] {
  const names = new Intl.DisplayNames([locale], { type: "region" });
  const english = new Intl.DisplayNames(["en"], { type: "region" });
  const order = new Intl.Collator(locale);
  return getCountries()
    .map((region) => ({
      region,
      code: codeOf(region),
      name: names.of(region) ?? region,
      english: english.of(region) ?? region,
      flag: flagOf(region),
    }))
    .sort((a, b) => order.compare(a.name, b.name));
}

/** Folds case and accents, so that "aland" finds Åland and "ita" Itävalta. */
const fold = (text: string): string =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();

/** The countries a search finds: by name in either language, or by code (46, +46, 0046). */
export function search(list: readonly Country[], query: string): Country[] {
  const words = fold(query.trim());
  if (words === "") return [...list];
  const digits = words.replace(/^(\+|00)/, "");
  if (/^\d+$/.test(digits))
    return list.filter((country) => country.code.slice(1).startsWith(digits));
  return list.filter(
    (country) => fold(country.name).includes(words) || fold(country.english).includes(words),
  );
}
