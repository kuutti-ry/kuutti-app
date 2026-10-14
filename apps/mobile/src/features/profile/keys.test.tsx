import { CompletenessItem } from "@kuutti/schema";
import { renderHook } from "@testing-library/react-native";
import { LocaleProvider, useT } from "@/lib/locale";
import {
  completenessText,
  fieldLabelKey,
  genderKey,
  optionKey,
  presetKey,
  promptKey,
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
      "A bio of 50 characters, a ready line, or two answered prompts",
    );
    expect(completenessText(t, "seeks")).toBe("Whom you are looking for (set in onboarding)");
    expect(completenessText(t, "age_window")).toBe("Your age window (set in onboarding)");
    const texts = CompletenessItem.options.map((item) => completenessText(t, item));
    expect(new Set(texts).size).toBe(CompletenessItem.options.length);
  });
});
