import { describe, expect, it } from "vitest";
import { intlLocale } from "./format.ts";
import {
  createI18n,
  formatDate,
  formatDateTime,
  formatHeight,
  formatNumber,
  formatPond,
  formatTime,
  LOCALE_NAMES,
  LOCALES,
  parseAcceptLanguage,
  RELEASED_LOCALES,
  realLocale,
  resolveLocale,
  typedT,
} from "./index.ts";

// The runtime with variable input (#13, #150, TD-17): plurals and selects at
// their boundaries in the three languages, fallbacks, and dates and numbers
// in Finland's conventions at the edges of a day and of a number.

const nbsp = "\u00a0";
const tIn = (locale: (typeof LOCALES)[number]) => typedT(createI18n({ locale }));

describe("plurals in every language", () => {
  it.each([
    ["en", 0, "Everyone has finished their profile."],
    ["en", 1, "1 person is still finishing their profile."],
    ["en", 2, "2 people are still finishing their profile."],
    ["en", 1000, `1${nbsp}000 people are still finishing their profile.`],
    ["fi", 0, "Kaikki ovat saaneet profiilinsa valmiiksi."],
    ["fi", 1, "1 ihminen viimeistelee vielä profiiliaan."],
    ["fi", 10, "10 ihmistä viimeistelee vielä profiiliaan."],
    ["fi", 12345, `12${nbsp}345 ihmistä viimeistelee vielä profiiliaan.`],
    ["sv", 0, "Alla har gjort klart sin profil."],
    ["sv", 1, "1 person håller fortfarande på med sin profil."],
    ["sv", 11, "11 personer håller fortfarande på med sin profil."],
  ] as const)("say %s for %i: %s", (locale, people, text) => {
    expect(tIn(locale)("pond.waitlist.finishing", { people })).toBe(text);
  });

  it.each([
    ["en", 1, "1 second"],
    ["en", 21, "21 seconds"],
    ["fi", 1, "1 sekunnin"],
    ["sv", 1, "1 sekund"],
    ["sv", 2, "2 sekunder"],
  ] as const)("count the seconds of a wait in %s: %i", (locale, seconds, phrase) => {
    expect(tIn(locale)("errors.rate_limited", { seconds })).toContain(phrase);
  });

  it.each([
    [
      "en",
      "Of the people with a finished profile who are looking for men or women, 30 percent are looking for men. 20 percent are looking for everyone. 50 percent are looking for women.",
    ],
    [
      "fi",
      "Valmiin profiilin tehneistä miehiä tai naisia etsivistä 30 prosenttia etsii miehiä. 20 prosenttia etsii kaikkia. 50 prosenttia etsii naisia.",
    ],
    [
      "sv",
      "Av personerna med färdig profil som söker män eller kvinnor söker 30 procent män. 20 procent söker alla. 50 procent söker kvinnor.",
    ],
  ] as const)("say the bar of a pond in three sentences in %s", (locale, text) => {
    const shares = { men: 30, everyone: 20, women: 50 };
    expect(tIn(locale)("pond.waitlist.seeks.label", shares)).toBe(text);
  });

  it("format the numbers of a message with the language's grouping and a decimal comma", () => {
    expect(tIn("en")("pond.waitlist.small", { k: 1200 })).toContain(`1${nbsp}200 people`);
    expect(tIn("en")("pond.waitlist.seeks.men", { share: 10.5 })).toBe("10,5 % men");
    expect(tIn("sv")("photos.count", { photos: 1, max: 6 })).toBe("1 foto, högst 6");
  });
});

describe("selects and fallbacks", () => {
  it.each([
    ["approved", "Approved"],
    ["rejected", "Rejected"],
    ["queued", "Decided"],
    ["", "Decided"],
  ])("choose the branch of %o, and other for anything else", (decision, text) => {
    expect(tIn("en")("admin.queue.decided", { decision })).toBe(text);
  });

  it.each(["fi", "sv"] as const)(
    "fall back from %s to the English of an English-only key",
    (locale) => {
      expect(tIn(locale)("admin.queue.total", { total: 0 })).toBe("Nothing waiting");
      expect(tIn(locale)("admin.queue.total", { total: 3 })).toBe("3 photos waiting");
    },
  );

  it("answer a key that is not in any catalogue with the key itself, never an empty string", () => {
    const t = tIn("fi") as unknown as (key: string) => string;
    expect(t("no.such.key")).toBe("no.such.key");
  });

  it("serve English for a language without a catalogue", () => {
    const t = typedT(createI18n({ locale: "de" as "en" }));
    expect(t("onboarding.retry")).toBe("Try again");
  });
});

describe("dates and times at the edges of a day", () => {
  const helsinki = { timeZone: "Europe/Helsinki" };

  it("put a late UTC evening on the next day in Finland, and a new year too", () => {
    const newYear = Date.UTC(2026, 11, 31, 22, 30);
    expect(formatDate("fi", newYear, { timeZone: "UTC" })).toBe("31.12.2026");
    expect(formatDate("fi", newYear, helsinki)).toBe("1.1.2027");
    expect(formatDateTime("sv", newYear, helsinki)).toBe("1.1.2027 00.30");
  });

  it.each([
    [Date.UTC(2026, 0, 1, 0, 0), "00.00"],
    [Date.UTC(2026, 0, 1, 23, 59), "23.59"],
    [Date.UTC(2026, 0, 1, 12, 5), "12.05"],
  ])("write %i as %s in every language, 24 hours and two digits", (at, text) => {
    for (const locale of ["en", "fi", "sv", "fi-x-stadi", "en-XA"] as const) {
      expect(formatTime(locale, at, { timeZone: "UTC" }), locale).toBe(text);
    }
  });

  it("take a Date as well as a timestamp", () => {
    const at = new Date(Date.UTC(2026, 1, 28, 9, 7));
    expect(formatDateTime("en", at, { timeZone: "UTC" })).toBe("28.2.2026 09.07");
  });
});

describe("numbers", () => {
  it.each([
    [0, "0"],
    [1_000_000, `1${nbsp}000${nbsp}000`],
    [0.125, "0,125"],
  ])("write %d in Finland's convention in every language", (value, text) => {
    for (const locale of ["en", "fi", "sv", "fi-x-stadi", "en-XA"] as const) {
      expect(formatNumber(locale, value), locale).toBe(text);
    }
  });

  it("write a negative number with the language's own minus sign", () => {
    // CLDR: Finnish and Swedish use U+2212, English in Finland the hyphen-minus.
    expect(formatNumber("fi", -1234.5)).toBe(`\u22121${nbsp}234,5`);
    expect(formatNumber("sv", -1234.5)).toBe(`\u22121${nbsp}234,5`);
    expect(formatNumber("en", -1234.5)).toBe(`-1${nbsp}234,5`);
  });

  it("pass Intl's options through", () => {
    expect(formatNumber("fi", 0.5, { style: "percent" })).toBe(`50${nbsp}%`);
    expect(formatNumber("en", 2.345, { maximumFractionDigits: 1 })).toBe("2,3");
  });

  it.each([
    [140, "140"],
    [171.5, "172"],
    [219.4, "219"],
  ])("write a height of %d cm whole", (cm, number) => {
    expect(formatHeight("sv", cm)).toBe(`${number}${nbsp}cm`);
  });

  it("map each catalogue to Finland's Intl locale, and leave any other tag as it is", () => {
    expect(["en", "fi", "sv", "fi-x-stadi", "en-XA", "de-DE"].map(intlLocale)).toEqual([
      "en-FI",
      "fi",
      "sv-FI",
      "fi-FI",
      "en-FI",
      "de-DE",
    ]);
  });
});

describe("a pond's name", () => {
  it.each([
    ["fi", "inessive", "Helsingissä"],
    ["fi", "nominative", "Helsinki"],
    ["fi-x-stadi", "inessive", "Helsingissä"],
    ["fi-x-stadi", "nominative", "Helsinki"],
    ["sv", "inessive", "Helsinki"],
    ["en", "nominative", "Helsinki"],
    ["en-XA", "inessive", "Helsinki"],
  ] as const)("in %s, %s, is %s", (locale, grammaticalCase, name) => {
    expect(
      formatPond({ name: "Helsinki", nameInessive: "Helsingissä" }, grammaticalCase, locale),
    ).toBe(name);
  });
});

describe("the language a request gets", () => {
  it.each([
    [["FI"], "fi"],
    [[" sv-FI "], "sv"],
    [["fi_FI"], "fi"],
    [["zh-Hant-TW", "nb-NO"], "en"],
    [["", "sv"], "sv"],
  ])("from %o is %s", (preferences, locale) => {
    expect(resolveLocale(preferences)).toBe(locale);
  });

  it("is the first allowed one when English is not allowed", () => {
    expect(resolveLocale(["de"], ["sv", "fi"])).toBe("sv");
  });

  it("is never Stadi, here or in a release: a request naming it is Finnish, like a Finnish phone", () => {
    expect(resolveLocale(["fi-x-stadi"])).toBe("fi");
    expect(resolveLocale(["fi-x-stadi"], RELEASED_LOCALES)).toBe("fi");
    expect(resolveLocale(["fi-FI"])).toBe("fi");
  });

  it.each([
    ["sv, fi", ["sv", "fi"]],
    ["fi;q=0.5, sv;q=0.5, en;q=0.9", ["en", "fi", "sv"]],
    ["fi;q=", ["fi"]],
    ["fi;q=1..5, sv", ["sv"]],
    ["fi;level=1;q=0.4, en;q=0.3", ["fi", "en"]],
    ["*", []],
    ["", []],
    [" , ;q=1, sv ", ["sv"]],
    ["fi;q=0.000", []],
  ])("reads Accept-Language %o as %o", (header, tags) => {
    expect(parseAcceptLanguage(header)).toEqual(tags);
  });

  it("reads a missing header as no preference", () => {
    expect(parseAcceptLanguage(null)).toEqual([]);
  });
});

describe("the language picker", () => {
  it("lists every language under its own name", () => {
    expect(LOCALES.map((locale) => LOCALE_NAMES[locale])).toEqual([
      "English",
      "Suomi",
      "Svenska",
      "Stadi",
    ]);
  });
});

// Stadin slangi (#521): a made-up language over Finnish.
describe("Stadi", () => {
  const stadi = tIn("fi-x-stadi");

  it("speaks slang where a key has a slangi text", () => {
    expect(stadi("round.like")).toBe("Digaan");
    expect(tIn("fi")("round.like")).toBe("Tykkää");
  });

  it.each([["onboarding.retry"], ["legal.terms.title"], ["push.round"]] as const)(
    "is the Finnish text where a key has none: %s",
    (key) => {
      expect(stadi(key)).toBe(tIn("fi")(key));
      expect(stadi(key)).not.toBe(tIn("en")(key));
    },
  );

  it("keeps Finnish plurals in a Finnish text", () => {
    expect(stadi("errors.rate_limited", { seconds: 1 })).toBe(
      tIn("fi")("errors.rate_limited", { seconds: 1 }),
    );
    expect(stadi("errors.rate_limited", { seconds: 30 })).toBe(
      tIn("fi")("errors.rate_limited", { seconds: 30 }),
    );
  });

  it("falls back to Finnish and nowhere else, and leaves Finnish's own fallback as it was", () => {
    expect(createI18n({ locale: "fi-x-stadi" }).languages).toEqual(["fi-x-stadi", "fi"]);
    expect(createI18n({ locale: "fi" }).languages).toEqual(["fi", "en"]);
    expect(createI18n({ locale: "sv" }).languages).toEqual(["sv", "en"]);
    // English only, so a key in no language it falls back to stays a key.
    expect(stadi("admin.title")).toBe("admin.title");
  });

  it("is the same for a t fixed to it on an instance in another language (the API's)", () => {
    const fixed = typedT(createI18n({ locale: "en" }), "fi-x-stadi");
    expect(fixed("round.like")).toBe("Digaan");
    expect(fixed("onboarding.retry")).toBe("Yritä uudelleen");
  });

  it("stays out of a release", () => {
    expect(RELEASED_LOCALES).not.toContain("fi-x-stadi");
  });

  it.each([
    ["fi-x-stadi", "fi"],
    ["fi", "fi"],
    ["sv", "sv"],
    ["en", "en"],
    ["en-XA", "en"],
    ["de", "en"],
    ["", "en"],
  ])("reads as a real language where one is needed: %j is %s", (locale, real) => {
    expect(realLocale(locale)).toBe(real);
  });
});
