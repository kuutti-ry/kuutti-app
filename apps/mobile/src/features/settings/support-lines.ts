import { type AnyLocale, type PlainMessageKey, type RealLocale, realLocale } from "@kuutti/i18n";
import { Linking } from "react-native";

/** The emergency number, above the services on the page. */
export const EMERGENCY_NUMBER = "112";

export type SupportLine = {
  id: string;
  name: PlainMessageKey;
  /** What it is for, from the service's own pages. */
  about: PlainMessageKey;
  /** Its hours, languages and cost, as its own site prints them. */
  hours: PlainMessageKey;
  logo: number;
  /** As the service prints it. */
  phone: string;
  /** A Swedish line of its own, where the service has one. */
  phoneSv?: string;
  /** Its page in each language, the nearest one where it has none. */
  site: Record<RealLocale, string>;
};

const MIELI_FI = "https://mieli.fi/tukea-ja-apua/kriisipuhelin/";
const TUKINAINEN_FI = "https://tukinainen.fi/kriisituki-seksuaalivakivallan-kokemuksen-jalkeen/";

/**
 * The four services of the support page (#510), those open all hours first.
 * Every number, hour and language is read from the service's own site, never
 * from memory or somebody's list, and read again before each release (the
 * page's row in docs/accessibility-checklist.md); last read 30/10/2026. A
 * logo stands here before its owner has been asked, and a service that says
 * no is replaced (apps/mobile/assets/support/NOTICE.md).
 */
export const SUPPORT_LINES: readonly SupportLine[] = [
  {
    id: "mieli",
    name: "support.mieli.name",
    about: "support.mieli.about",
    hours: "support.mieli.hours",
    logo: require("../../../assets/support/mieli.png"),
    phone: "09 2525 0111",
    phoneSv: "09 2525 0112",
    site: {
      fi: MIELI_FI,
      sv: "https://mieli.fi/sv/stod-och-hjalp/kristelefon/",
      // The line has no English page, and MIELI's English pages still print
      // the number of the English line that closed on 23.3.2026.
      en: MIELI_FI,
    },
  },
  {
    id: "nollalinja",
    name: "support.nollalinja.name",
    about: "support.nollalinja.about",
    hours: "support.nollalinja.hours",
    logo: require("../../../assets/support/nollalinja.png"),
    // Not 080 005 005, the old number other sites still print.
    phone: "116 016",
    site: {
      fi: "https://nollalinja.fi/",
      sv: "https://nollalinja.fi/sv/",
      en: "https://nollalinja.fi/en/",
    },
  },
  {
    id: "riku",
    name: "support.riku.name",
    about: "support.riku.about",
    hours: "support.riku.hours",
    logo: require("../../../assets/support/riku.png"),
    phone: "116 006",
    site: {
      fi: "https://www.riku.fi/palvelut/rikosuhripaivystys-116-006/",
      sv: "https://www.riku.fi/sv/tjansterna/brottsofferjouren-116-006/",
      en: "https://www.riku.fi/en/services/victim-support-finland-116-006/",
    },
  },
  {
    id: "tukinainen",
    name: "support.tukinainen.name",
    about: "support.tukinainen.about",
    hours: "support.tukinainen.hours",
    logo: require("../../../assets/support/tukinainen.png"),
    phone: "0800 97899",
    site: {
      fi: TUKINAINEN_FI,
      // No Swedish page. The English one still printed Mon-Thu on 30/10/2026,
      // when the Finnish pages had gone to Mon and Wed: the tile's hours are the newer.
      sv: TUKINAINEN_FI,
      en: "https://tukinainen.fi/rape-crises-center-tukinainen/",
    },
  },
];

/** The number to dial: a `tel:` link holds no spaces. */
export const telOf = (number: string): string => `tel:${number.replaceAll(" ", "")}`;

/**
 * What a tile offers to dial. In Swedish, a Swedish line comes first, and the
 * service's main line stays beside it, each named: the Swedish line has hours,
 * and somebody reading Swedish at night still needs a line that answers.
 */
export const numbersOf = (
  line: SupportLine,
  locale: AnyLocale,
): ReadonlyArray<{ number: string; language?: PlainMessageKey }> =>
  locale === "sv" && line.phoneSv
    ? [
        { number: line.phoneSv, language: "support.line.swedish" },
        { number: line.phone, language: "support.line.finnish" },
      ]
    : [{ number: line.phone }];

/** The service's page in the language of the app; the pseudo-locale reads English, Stadi Finnish. */
export const siteOf = (line: SupportLine, locale: AnyLocale): string =>
  line.site[realLocale(locale)];

/**
 * Opens a number or a site. A refusal stays quiet: on a device that cannot
 * call the number is there on the button for another phone, and an unhandled
 * rejection would carry the address, which names the service, to a crash report.
 */
export const openQuietly = (url: string): Promise<unknown> =>
  Linking.openURL(url).catch(() => undefined);
