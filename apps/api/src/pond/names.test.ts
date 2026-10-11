import { SEED_PONDS } from "@kuutti/db";
import { createI18n } from "@kuutti/i18n";
import { describe, expect, it } from "vitest";

// A pond's name in the person's language is a catalogue entry by slug
// (#174, ADR-010 §12), read by the app; here, where the seed and the
// catalogue are both dependencies, a seeded pond without a name in every
// language would reach a screen under its Finnish name only.
describe("the names of the seeded ponds", () => {
  const i18n = createI18n({ locale: "en" });
  const has = (locale: string, key: string) =>
    i18n.getResource(locale, "translation", key) !== undefined;

  it("exist in English, Finnish and Swedish for every seeded pond", () => {
    const missing = ["en", "fi", "sv"].flatMap((locale) =>
      SEED_PONDS.map((pond) => `pond.name.${pond.slug}`)
        .filter((key) => !has(locale, key))
        .map((key) => `${locale}: ${key}`),
    );
    expect(missing).toEqual([]);
    // The Finnish name of the catalogue is the seed's nominative, so the two never drift.
    for (const pond of SEED_PONDS) {
      expect(i18n.getResource("fi", "translation", `pond.name.${pond.slug}`)).toBe(
        pond.nameNominative,
      );
    }
  });
});
