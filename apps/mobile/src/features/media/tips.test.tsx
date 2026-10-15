import { createI18n, typedT } from "@kuutti/i18n";
import { FishSpecies, TipKind } from "@kuutti/schema";
import { act, fireEvent, renderHook, screen } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { View } from "react-native";
import { LocaleProvider, useT } from "@/lib/locale";
import { renderWithTheme, underProviders } from "@/test/render";
import { PhotoTip, tipText } from "./tips";

// The words for what the API names by kind (#56, #287): every tip has its own
// text, and the fish tip names the fish. A tip is said once per main photo,
// remembered on the device (#297).

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const SEEN = "kuutti.preference.photoTipsSeen";
/** The screen without the tip: leaving it, to the component. */
const nothing = <View />;
const seen = () => JSON.parse(store.get(SEEN) ?? "{}") as unknown;
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));

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

describe("PhotoTip", () => {
  beforeEach(() => store.delete(SEEN));

  it("says a tip once for the main photo (#297): not again once the screen was left, again when another photo was main meanwhile; a dismissal counts too", async () => {
    const fish = <PhotoTip tips={["fish"]} fishSpecies={null} mainId="photo-a" />;
    const view = await renderWithTheme(fish);
    await settle();
    expect(screen.getByText(/A fish in the main photo is a classic/)).toBeTruthy();
    // Leaving the screen with the tip on counts as having heard it.
    await view.rerender(underProviders(nothing));
    await settle();
    expect(seen()).toEqual({ mainId: "photo-a", kinds: ["fish"] });

    await view.rerender(underProviders(fish));
    await settle();
    expect(screen.queryByText("A tip for your photos")).toBeNull();
    await view.rerender(underProviders(nothing));

    // Another photo is the main one: what applies to it is said, and the record starts afresh.
    await view.rerender(
      underProviders(
        <PhotoTip tips={["blurry", "few_photos"]} fishSpecies={null} mainId="photo-b" />,
      ),
    );
    await settle();
    expect(screen.getByText("Try a sharper photo.")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Got it" }));
    await settle();
    // The next tip takes its place, and the dismissal is on the device.
    expect(screen.getByText(/fuller picture/)).toBeTruthy();
    expect(seen()).toEqual({ mainId: "photo-b", kinds: ["blurry"] });
    await view.rerender(underProviders(nothing));
    await settle();
    expect(seen()).toEqual({ mainId: "photo-b", kinds: ["blurry", "few_photos"] });

    // The fish photo chosen again earns its tip again (the maintainer, 15/10/2026).
    await view.rerender(
      underProviders(<PhotoTip tips={["fish"]} fishSpecies="pike" mainId="photo-a" />),
    );
    await settle();
    expect(screen.getByText(/Is that a pike\?/)).toBeTruthy();
    await view.rerender(underProviders(nothing));
    await settle();
    expect(seen()).toEqual({ mainId: "photo-a", kinds: ["fish"] });
  });

  it("reads nothing into a stored value it does not understand, and says nothing without a tip", async () => {
    store.set(SEEN, "not json");
    const view = await renderWithTheme(
      <PhotoTip tips={["blurry"]} fishSpecies={null} mainId="photo-a" />,
    );
    await settle();
    expect(screen.getByText("Try a sharper photo.")).toBeTruthy();
    await view.rerender(underProviders(nothing));
    await settle();
    expect(seen()).toEqual({ mainId: "photo-a", kinds: ["blurry"] });
    // Only kinds this build knows survive a read; a record of another shape is no record.
    store.set(SEEN, JSON.stringify({ mainId: "photo-a", kinds: ["blurry", "nonsense", 7] }));
    await view.rerender(
      underProviders(<PhotoTip tips={["blurry", "fish"]} fishSpecies={null} mainId="photo-a" />),
    );
    await settle();
    expect(screen.getByText(/A fish in the main photo is a classic/)).toBeTruthy();
    await view.rerender(underProviders(nothing));
    await settle();
    expect(seen()).toEqual({ mainId: "photo-a", kinds: ["blurry", "fish"] });
    for (const odd of [
      "[]",
      JSON.stringify({ fish: "photo-a" }),
      JSON.stringify({ mainId: 1, kinds: [] }),
    ]) {
      store.set(SEEN, odd);
      await view.rerender(
        underProviders(<PhotoTip tips={["fish"]} fishSpecies={null} mainId="photo-a" />),
      );
      await settle();
      expect(screen.getByText(/A fish in the main photo is a classic/)).toBeTruthy();
      await view.rerender(underProviders(nothing));
      await settle();
    }
    await view.rerender(underProviders(<PhotoTip tips={[]} fishSpecies={null} mainId={null} />));
    await settle();
    expect(screen.queryByText("A tip for your photos")).toBeNull();
  });
});
