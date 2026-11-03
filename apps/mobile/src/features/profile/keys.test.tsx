import { createI18n, type Locale, typedT } from "@kuutti/i18n";
import {
  CompletenessItem,
  DealBreakerField,
  DISTANCE_BANDS,
  dealBreakerOptions,
  GENDERS,
  type HomeSummary,
} from "@kuutti/schema";
import { renderHook } from "@testing-library/react-native";
import { LocaleProvider, useT } from "@/lib/locale";
import {
  completenessText,
  fieldLabelKey,
  filterOptionKey,
  genderKey,
  optionKey,
  placeName,
  presetKey,
  promptKey,
  seeksKey,
  shownPlaceName,
} from "./keys";

// The registry's keys and the words for what the API names by kind (#47, #56):
// every completeness item and every tip has its own text, and the thresholds
// in the words are the contract's.

async function english() {
  const { result } = await renderHook(() => useT(), { wrapper: LocaleProvider });
  return result.current.t;
}

describe("the profile's message keys", () => {
  it("are built from the registry's names", () => {
    expect(genderKey("non_binary")).toBe("onboarding.gender.non_binary");
    expect(fieldLabelKey("height")).toBe("profile.field.height");
    expect(optionKey("intent", "long_term")).toBe("profile.option.intent.long_term");
    expect(promptKey("sunday")).toBe("profile.prompt.sunday");
    expect(presetKey("photos_speak")).toBe("profile.bioPreset.photos_speak");
  });

  it("name the distance, which is no field of the registry, the same way (ADR-061 §7)", () => {
    expect(fieldLabelKey("distance")).toBe("profile.field.distance");
    expect(optionKey("distance", "far")).toBe("profile.option.distance.far");
  });

  describe("an answer as a deal-breaker names it (#551)", () => {
    it.each([
      ["smoking", "never", "profile.filterOption.smoking.never"],
      ["hasKids", "yes_with_me", "profile.filterOption.hasKids.yes_with_me"],
      ["hasKids", "no", "profile.filterOption.hasKids.no"],
      ["wantsKids", "not_sure", "profile.filterOption.wantsKids.not_sure"],
    ] as const)(
      "has words of its own for %s %s, which the person's own are not",
      (field, option, key) => {
        expect(filterOptionKey(field, option)).toBe(key);
      },
    );

    it.each([
      ["smoking", "regularly"],
      ["monogamy", "monogamous"],
      ["languages", "fi"],
      ["height", "taller"],
      ["distance", "nearby"],
    ] as const)(
      "reads %s %s as the person's own, since those words fit anybody",
      (field, option) => {
        expect(filterOptionKey(field, option)).toBe(optionKey(field, option));
      },
    );

    it.each(["en", "fi", "sv"] as const)(
      "has every answer of every deal-breaker in %s, none a key",
      (locale) => {
        const t = typedT(createI18n({ locale }));
        for (const field of DealBreakerField.options) {
          const words = dealBreakerOptions(field).map((option) => {
            const key = filterOptionKey(field, option);
            expect(t(key)).not.toBe(key);
            return t(key);
          });
          expect(new Set(words).size).toBe(words.length);
        }
      },
    );

    it("is in the third person in Finnish, where the person's own are in the first", () => {
      const t = typedT(createI18n({ locale: "fi" }));
      expect(t(filterOptionKey("smoking", "never"))).toBe("Ei koskaan");
      expect(t(optionKey("smoking", "never"))).toBe("En koskaan");
      expect(t(filterOptionKey("wantsKids", "want"))).toBe("Haluaa lapsia");
      expect(t(optionKey("wantsKids", "want"))).toBe("Haluan lapsia");
    });
  });

  // The API builds the label's key from the field in the export (erasure.ts).
  it.each(["en", "fi", "sv"] as const)("have the distance's words in %s, none a key", (locale) => {
    const t = typedT(createI18n({ locale }));
    const words = [
      fieldLabelKey("distance"),
      ...DISTANCE_BANDS.map((b) => optionKey("distance", b)),
    ];
    for (const key of words) expect(t(key)).not.toBe(key);
    expect(new Set(words.map((key) => t(key))).size).toBe(words.length);
  });

  it("say the bands in the brief's English", () => {
    const t = typedT(createI18n({ locale: "en" }));
    expect(DISTANCE_BANDS.map((band) => t(optionKey("distance", band)))).toEqual([
      "Nearby",
      "Close",
      "Around",
      "Far",
    ]);
    expect(t(fieldLabelKey("distance"))).toBe("Distance");
  });

  // A woman one seeks is said apart from a woman one is: the seeks step's words (#146, #542).
  it.each([
    ["en", ["Women", "Men", "Non-binary people"]],
    ["fi", ["Naisia", "Miehiä", "Muunsukupuolisia"]],
    ["sv", ["Kvinnor", "Män", "Icke-binära personer"]],
  ] as const)("say whom one seeks in %s, a word for every gender", (locale, words) => {
    const t = typedT(createI18n({ locale }));
    expect(GENDERS).toEqual(["woman", "man", "non_binary"]);
    expect(GENDERS.map((gender) => t(seeksKey(gender)))).toEqual(words);
  });
});

describe("placeName", () => {
  const KALLIO = { fi: "Kallio", sv: "Berghäll" };

  it.each<[Locale, string]>([
    ["en", "Kallio"],
    ["fi", "Kallio"],
    ["sv", "Berghäll"],
    ["fi-x-stadi", "Kallio"],
  ])("reads a place in %s as the list has it", (locale, name) => {
    expect(placeName(KALLIO, locale)).toBe(name);
  });

  it("reads the pseudo-locale as the English it stands for", () => {
    expect(placeName(KALLIO, "en-XA")).toBe("Kallio");
  });
});

describe("shownPlaceName", () => {
  const town = { fi: "Helsinki", sv: "Helsingfors" };
  const area = { fi: "Kallio", sv: "Berghäll" };

  it.each<[string, HomeSummary, string]>([
    ["the town by default", { town, area, showArea: false }, "Helsinki"],
    ["the area where the person chose it", { town, area, showArea: true }, "Kallio"],
    ["the town where no area is kept", { town, area: null, showArea: false }, "Helsinki"],
    [
      "the town if the answer ever says area with none",
      { town, area: null, showArea: true },
      "Helsinki",
    ],
  ])("says %s", (_what, home, name) => {
    expect(shownPlaceName(home, "en")).toBe(name);
  });

  it("says it in the reader's language", () => {
    expect(shownPlaceName({ town, area, showArea: false }, "sv")).toBe("Helsingfors");
    expect(shownPlaceName({ town, area, showArea: true }, "sv")).toBe("Berghäll");
  });
});

describe("completenessText", () => {
  it("says each missing item in its own words, with the contract's thresholds", async () => {
    const t = await english();
    expect(completenessText(t, "display_name")).toBe("A name on the card");
    expect(completenessText(t, "photos")).toBe("At least 2 approved photos");
    expect(completenessText(t, "bio_or_prompts")).toBe(
      "A bio of 50 characters, a ready line, or two answered prompts",
    );
    expect(completenessText(t, "seeks")).toBe("Whom you are looking for (set in onboarding)");
    expect(completenessText(t, "age_window")).toBe("Your age window (set in onboarding)");
    const texts = CompletenessItem.options.map((item) => completenessText(t, item));
    expect(new Set(texts).size).toBe(CompletenessItem.options.length);
  });
});
