import { describe, expect, it } from "vitest";
import {
  createI18n,
  formatDate,
  formatNumber,
  formatPond,
  parseAcceptLanguage,
  RELEASED_LOCALES,
  resolveLocale,
  typedT,
} from "./index.ts";
import { enXA } from "./pseudo.ts";

describe("t()", () => {
  it("renders a key in English and in Finnish", () => {
    expect(typedT(createI18n({ locale: "en" }))("onboarding.retry")).toBe("Try again");
    expect(typedT(createI18n({ locale: "fi" }))("onboarding.retry")).toBe("Yritä uudelleen");
  });

  it("formats ICU arguments and plurals per locale", () => {
    const i18n = createI18n({ locale: "en" });
    expect(typedT(i18n)("tech.api.commit", { commit: "abc1234" })).toBe("git commit abc1234");
    expect(typedT(i18n)("errors.rate_limited", { seconds: 1 })).toBe(
      "Too many requests. Try again in 1 second.",
    );
    expect(typedT(i18n, "sv")("errors.rate_limited", { seconds: 30 })).toBe(
      "För många förfrågningar. Försök igen om 30 sekunder.",
    );
  });

  it("falls back to English for a key a locale does not have (fi to en, sv to en)", () => {
    // admin.* is English only, so it is missing from fi and sv by design.
    expect(typedT(createI18n({ locale: "fi" }))("admin.title")).toBe("Kuutti admin");
    expect(typedT(createI18n({ locale: "sv" }))("admin.title")).toBe("Kuutti admin");
  });

  it("offers en-XA only when a dev build hands the catalogue in", () => {
    expect(typedT(createI18n({ locale: "en-XA", pseudo: enXA }))("onboarding.retry")).toBe(
      "［Trýý áágááííñ］",
    );
    expect(typedT(createI18n({ locale: "en-XA" }))("onboarding.retry")).toBe("Try again");
  });

  it("changes language on one instance, and a fixed t ignores the change (the API's per-request t)", async () => {
    const i18n = createI18n({ locale: "en" });
    const fixedFi = typedT(i18n, "fi");
    await i18n.changeLanguage("sv");
    expect(typedT(i18n)("onboarding.retry")).toBe("Försök igen");
    expect(fixedFi("onboarding.retry")).toBe("Yritä uudelleen");
  });

  it("makes an unknown key and wrong arguments type errors", () => {
    const t = typedT(createI18n({ locale: "en" }));
    // Compile-time assertions: tsc fails on an unused @ts-expect-error.
    // @ts-expect-error not a key of messages.yaml
    t("does.not.exist");
    // @ts-expect-error errors.rate_limited needs { seconds: number }
    t("errors.rate_limited");
    // @ts-expect-error seconds is a number
    t("errors.rate_limited", { seconds: "3" });
    // @ts-expect-error onboarding.retry takes no arguments
    t("onboarding.retry", { extra: 1 });
    expect(t("home.title")).toBe("Kuutti");
  });
});

describe("locale resolution", () => {
  it("picks the first preference with a catalogue, by language, else English", () => {
    expect(resolveLocale(["fi-FI", "en-US"])).toBe("fi");
    expect(resolveLocale(["de-DE", "sv_SE", "fi"])).toBe("sv");
    expect(resolveLocale(["de-DE"])).toBe("en");
    expect(resolveLocale([])).toBe("en");
    // The answer is always one of the allowed locales (#55).
    expect(resolveLocale(["sv-FI", "fi"], ["en", "fi"])).toBe("fi");
    expect(resolveLocale(["sv"], ["en", "fi"])).toBe("en");
    expect(resolveLocale(["sv"], ["fi"])).toBe("fi");
    expect(() => resolveLocale(["fi"], [])).toThrow(/at least one/);
  });

  it("offers only the released languages where it is told to: Swedish waits for its reviewer", () => {
    expect(RELEASED_LOCALES).toEqual(["en", "fi"]);
    expect(resolveLocale(["sv-FI", "fi-FI"], RELEASED_LOCALES)).toBe("fi");
    expect(resolveLocale(["sv-FI"], RELEASED_LOCALES)).toBe("en");
    expect(resolveLocale(["sv-FI"])).toBe("sv");
  });

  it("reads Accept-Language by weight and drops q=0 and the wildcard", () => {
    expect(parseAcceptLanguage("en;q=0.5, fi-FI, sv;q=0.8, *;q=0.1, de;q=0")).toEqual([
      "fi-FI",
      "sv",
      "en",
    ]);
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    // A hostile header is cut off, not processed: the tag past the cap is never seen.
    expect(parseAcceptLanguage(`${",".repeat(300)}fi`)).toEqual([]);
    expect(resolveLocale(parseAcceptLanguage("fi;q=0.9, en"))).toBe("en");
  });
});

describe("formatting", () => {
  it("goes through Intl for dates and numbers", () => {
    const day = Date.UTC(2026, 8, 19, 12);
    expect(formatDate("fi", day, { dateStyle: "medium", timeZone: "UTC" })).toBe("19.9.2026");
    expect(formatDate("en-XA", day, { dateStyle: "medium", timeZone: "UTC" })).toBe("19 Sept 2026");
    expect(formatNumber("fi", 1234.5)).toBe("1\u00a0234,5");
  });

  it("formats in Finland's locale in every language: day first, 24-hour time, decimal comma", () => {
    const at = Date.UTC(2026, 8, 19, 14, 14);
    const short = { dateStyle: "short", timeStyle: "short", timeZone: "UTC" } as const;
    expect(formatDate("en", at, short)).toBe("19/09/2026, 14.14");
    expect(formatDate("sv", at, short)).toBe("19.9.2026 14.14");
    expect(formatDate("fi", at, short)).toBe("19.9.2026 klo 14.14");
    expect(formatNumber("en", 1234.5)).toBe("1\u00a0234,5");
    expect(formatNumber("sv", 1234.5)).toBe("1\u00a0234,5");
  });

  it("formats ICU date arguments the same way, through i18next-icu", () => {
    const at = Date.UTC(2026, 8, 19, 14, 14);
    // The pseudo catalogue is the one catalogue a test may extend without messages.yaml.
    const i18n = createI18n({
      locale: "en-XA",
      pseudo: { ...enXA, "test.when": "{at, date, short} {at, time, short}" },
    });
    // ICU's own "short" date is a two-digit year, and a message has no time
    // zone, so the hour is the runner's: day first and the 24-hour dot are the point.
    expect(i18n.t("test.when", { at })).toMatch(/^19\/09\/26 \d\d\.\d\d$/);
  });

  it("reads a pond's case form from the database and never builds one", () => {
    // The shape of PondSummary: every case form is required, so none is dropped silently.
    const helsinki = { name: "Helsinki", nameInessive: "Helsingissä" };
    expect(formatPond(helsinki, "inessive", "fi")).toBe("Helsingissä");
    expect(formatPond(helsinki, "inessive", "en")).toBe("Helsinki");
    expect(formatPond(helsinki, "inessive", "sv")).toBe("Helsinki");
    expect(formatPond(helsinki, "nominative", "fi")).toBe("Helsinki");
  });
});
