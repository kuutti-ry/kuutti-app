import { act, render, renderHook, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import type * as React from "react";
import { LocaleProvider } from "./locale";
import {
  DEFAULT_PHOTO_DESCRIPTION_SETTINGS,
  PhotoDescriptionsProvider,
  readPhotoDescriptionSettings,
  usePhotoDescriptionSettings,
  usePhotoDescriptionText,
} from "./photo-descriptions";

// The Photo descriptions setting (#296 part 3): what is stored and read
// back, the defaults where nothing or nonsense is stored, and the words the
// hook makes of a photo's description for the label and the text under it.

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const KEY = "kuutti.preference.photoDescriptions";
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <LocaleProvider>
    <PhotoDescriptionsProvider>{children}</PhotoDescriptionsProvider>
  </LocaleProvider>
);
const lakeside = {
  people: 1,
  setting: "outdoors" as const,
  scene: ["lake" as const],
  objects: ["hiking" as const, "dog" as const],
  smile: true,
  glasses: false,
  sunglasses: true,
  facialHair: false,
};

beforeEach(() => store.clear());

describe("readPhotoDescriptionSettings", () => {
  it("is the defaults where nothing, nonsense or no object is stored: not shown, every part told", () => {
    expect(DEFAULT_PHOTO_DESCRIPTION_SETTINGS).toEqual({
      shown: false,
      people: true,
      face: true,
      objects: true,
    });
    for (const raw of [null, "", "{", "null", "[true]", '"shown"', "42"]) {
      expect(readPhotoDescriptionSettings(raw)).toEqual(DEFAULT_PHOTO_DESCRIPTION_SETTINGS);
    }
  });

  it("takes each stored boolean and the default for the rest, whatever else is stored", () => {
    expect(readPhotoDescriptionSettings(JSON.stringify({ shown: true, face: false }))).toEqual({
      shown: true,
      people: true,
      face: false,
      objects: true,
    });
    expect(
      readPhotoDescriptionSettings(
        JSON.stringify({ shown: "yes", people: 0, objects: null, extra: true }),
      ),
    ).toEqual(DEFAULT_PHOTO_DESCRIPTION_SETTINGS);
  });
});

describe("the provider", () => {
  it("reads the stored choice once and writes every change back as JSON", async () => {
    store.set(KEY, JSON.stringify({ shown: true }));
    const { result } = await renderHook(() => usePhotoDescriptionSettings(), { wrapper });
    await waitFor(() => expect(result.current.settings.shown).toBe(true));
    await act(async () => result.current.set({ face: false }));
    expect(result.current.settings).toEqual({
      shown: true,
      people: true,
      face: false,
      objects: true,
    });
    await waitFor(() =>
      expect(JSON.parse(store.get(KEY) ?? "{}")).toEqual({
        shown: true,
        people: true,
        face: false,
        objects: true,
      }),
    );
  });

  it("is needed above the hooks", async () => {
    const silence = jest.spyOn(console, "error").mockImplementation(() => undefined);
    function Probe() {
      usePhotoDescriptionSettings();
      return null;
    }
    await expect(render(<Probe />)).rejects.toThrow(
      "usePhotoDescriptionSettings needs a PhotoDescriptionsProvider",
    );
    silence.mockRestore();
  });
});

describe("usePhotoDescriptionText", () => {
  it("puts the description after a label as its own sentence, and nothing after a photo without one", async () => {
    const { result } = await renderHook(() => usePhotoDescriptionText(), { wrapper });
    await waitFor(() => expect(result.current.shown).toBe(false));
    expect(result.current.describe(lakeside)).toBe(
      "Automatic description: One person, outdoors, by a lake. Smiling, sunglasses. Hiking, with a dog.",
    );
    expect(result.current.label("Photo 1 / 2", lakeside)).toBe(
      "Photo 1 / 2. Automatic description: One person, outdoors, by a lake. Smiling, sunglasses. Hiking, with a dog.",
    );
    // A label that ends a sentence already, or names the caption, gets a full stop once.
    expect(result.current.label("Photo 1 / 2, full size. Travelling", lakeside)).toBe(
      "Photo 1 / 2, full size. Travelling. Automatic description: One person, outdoors, by a lake. Smiling, sunglasses. Hiking, with a dog.",
    );
    expect(result.current.label("Kuva 1 / 2.", lakeside)).toBe(
      "Kuva 1 / 2. Automatic description: One person, outdoors, by a lake. Smiling, sunglasses. Hiking, with a dog.",
    );
    expect(result.current.describe(null)).toBeNull();
    expect(result.current.describe(undefined)).toBeNull();
    expect(result.current.label("Photo 2 / 2", null)).toBe("Photo 2 / 2");
  });

  it("leaves out the parts turned off, in the label and the text alike, and says nothing with every part off", async () => {
    store.set(KEY, JSON.stringify({ shown: true, people: false, face: true, objects: false }));
    const { result } = await renderHook(() => usePhotoDescriptionText(), { wrapper });
    await waitFor(() => expect(result.current.shown).toBe(true));
    expect(result.current.describe(lakeside)).toBe("Automatic description: Smiling, sunglasses.");
    expect(result.current.label("Photo 1 / 1", lakeside)).toBe(
      "Photo 1 / 1. Automatic description: Smiling, sunglasses.",
    );
    store.set(KEY, JSON.stringify({ people: false, face: false, objects: false }));
    const { result: none } = await renderHook(() => usePhotoDescriptionText(), { wrapper });
    await waitFor(() => expect(none.current.describe(lakeside)).toBeNull());
    expect(none.current.label("Photo 1 / 1", lakeside)).toBe("Photo 1 / 1");
  });
});
