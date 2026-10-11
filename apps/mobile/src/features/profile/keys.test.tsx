import { CompletenessItem, TipKind } from "@kuutti/schema";
import { renderHook } from "@testing-library/react-native";
import { LocaleProvider, useT } from "@/lib/locale";
import {
  completenessText,
  fieldLabelKey,
  genderKey,
  optionKey,
  presetKey,
  promptKey,
  tipText,
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
});

describe("completenessText", () => {
  it("says each missing item in its own words, with the contract's thresholds", async () => {
    const t = await english();
    expect(completenessText(t, "display_name")).toBe("A name on the card");
    expect(completenessText(t, "photos")).toBe("At least 2 approved photos");
    expect(completenessText(t, "bio_or_prompts")).toBe(
      "A bio of 50 characters, or two answered prompts",
    );
    expect(completenessText(t, "seeks")).toBe("Whom you are looking for (set in onboarding)");
    expect(completenessText(t, "age_window")).toBe("Your age window (set in onboarding)");
    const texts = CompletenessItem.options.map((item) => completenessText(t, item));
    expect(new Set(texts).size).toBe(CompletenessItem.options.length);
  });
});

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
});
