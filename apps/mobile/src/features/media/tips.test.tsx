import { createI18n, typedT } from "@kuutti/i18n";
import { FishSpecies, TipKind } from "@kuutti/schema";
import { renderHook } from "@testing-library/react-native";
import { LocaleProvider, useT } from "@/lib/locale";
import { tipText } from "./tips";

// The words for what the API names by kind (#56, #287): every tip has its own
// text, and the fish tip names the fish.

async function english() {
  const { result } = await renderHook(() => useT(), { wrapper: LocaleProvider });
  return result.current.t;
}

describe("tipText", () => {
  it("has its own words for every kind of tip, never the key", async () => {
    const t = await english();
    expect(tipText(t, "sunglasses")).toBe(
      "Try a photo where your eyes are clear, without sunglasses.",
    );
    expect(tipText(t, "mirror_selfie")).toBe("Try a photo that is not a mirror selfie.");
    expect(tipText(t, "tight_crop")).toBe(
      "Try a photo that shows a little more of you than a close-up face.",
    );
    expect(tipText(t, "group_photo")).toBe(
      "Try a photo where you are the only person in the frame.",
    );
    expect(tipText(t, "poor_lighting")).toBe("Try a photo taken in clearer light.");
    expect(tipText(t, "blurry")).toBe("Try a sharper photo.");
    expect(tipText(t, "few_photos")).toBe(
      "More approved photos would help others get a fuller picture of you.",
    );
    for (const kind of TipKind.options) expect(tipText(t, kind)).not.toMatch(/^profile\./);
  });

  it("names the fish of the fish tip in each language, and keeps the plain tip without one (#253)", async () => {
    const t = await english();
    expect(tipText(t, "fish", "pike")).toBe(
      "A mighty catch, and we are proud of you! Is that a pike? For the main photo, though, try one without the catch, and let the fish come second.",
    );
    expect(tipText(t, "fish", "eel")).toContain("Is that an eel?");
    expect(tipText(t, "fish")).toBe(tipText(t, "fish", null));
    expect(tipText(t, "fish")).toContain("A fish in the main photo is a classic.");
    // A species is named only on the fish tip.
    expect(tipText(t, "sunglasses", "pike")).toBe(tipText(t, "sunglasses"));
    const fi = typedT(createI18n({ locale: "fi" }), "fi");
    const sv = typedT(createI18n({ locale: "sv" }), "sv");
    expect(tipText(fi, "fish", "pike")).toContain("Onko se hauki?");
    expect(tipText(sv, "fish", "pike")).toContain("Är det en gädda?");
    // Every species has its own word in every language, never the fallback.
    for (const species of FishSpecies.options) {
      expect(tipText(t, "fish", species)).not.toContain("a fish?");
      expect(tipText(fi, "fish", species)).not.toContain("Onko se kala?");
      expect(tipText(sv, "fish", species)).not.toContain("en fisk?");
    }
  });
});
