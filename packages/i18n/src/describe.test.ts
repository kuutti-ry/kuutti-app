import { describe, expect, it } from "vitest";
import { ALL_DESCRIPTION_PARTS, describePhoto, type PhotoDescriptionKeys } from "./describe.ts";
import { createI18n, typedT } from "./index.ts";

// The automatic photo description in words (#296): the keys the API sends,
// said in the reader's language in the issue's order, the people and the
// setting first, then the face, then the activity and objects; and only the
// parts the reader asked for.

const lakeside: PhotoDescriptionKeys = {
  people: 1,
  setting: "outdoors",
  scene: ["lake"],
  objects: ["hiking", "dog"],
  smile: true,
  glasses: false,
  sunglasses: true,
  facialHair: false,
};
const t = (locale: "en" | "fi" | "sv") => typedT(createI18n({ locale }), locale);

describe("describePhoto", () => {
  it("says the people and the setting, the face, then the activity and objects, in three languages", () => {
    expect(describePhoto(t("en"), lakeside)).toBe(
      "Automatic description: One person, outdoors, by a lake. Smiling, sunglasses. Hiking, with a dog.",
    );
    expect(describePhoto(t("fi"), lakeside)).toBe(
      "Automaattinen kuvaus: Yksi henkilö, ulkona, järven rannalla. Hymyilee, aurinkolasit. Vaeltamassa, koiran kanssa.",
    );
    expect(describePhoto(t("sv"), lakeside)).toBe(
      "Automatisk beskrivning: En person, utomhus, vid en sjö. Ler, solglasögon. På vandring, med en hund.",
    );
  });

  it("counts people in the plural, and lists every scene and face part the check said", () => {
    expect(
      describePhoto(t("en"), {
        people: 2,
        setting: "indoors",
        scene: ["kitchen", "living_room"],
        objects: [],
        smile: false,
        glasses: true,
        sunglasses: false,
        facialHair: true,
      }),
    ).toBe(
      "Automatic description: 2 people, indoors, in a kitchen, in a living room. Glasses, facial hair.",
    );
    expect(
      describePhoto(t("fi"), {
        people: 3,
        setting: null,
        scene: [],
        objects: ["coffee"],
        smile: false,
        glasses: false,
        sunglasses: false,
        facialHair: false,
      }),
    ).toBe("Automaattinen kuvaus: 3 henkilöä. Kahvin kanssa.");
  });

  it("leaves out a part the reader turned off, and says nothing when nothing is left", () => {
    expect(describePhoto(t("en"), lakeside, { people: true, face: false, objects: true })).toBe(
      "Automatic description: One person, outdoors, by a lake. Hiking, with a dog.",
    );
    expect(describePhoto(t("en"), lakeside, { people: false, face: true, objects: false })).toBe(
      "Automatic description: Smiling, sunglasses.",
    );
    expect(
      describePhoto(t("en"), lakeside, { people: false, face: false, objects: false }),
    ).toBeNull();
    expect(ALL_DESCRIPTION_PARTS).toEqual({ people: true, face: true, objects: true });
  });

  it("says nothing for a check that saw nobody, nowhere, with nothing, and skips an empty sentence in between", () => {
    const nothing: PhotoDescriptionKeys = {
      people: 0,
      setting: null,
      scene: [],
      objects: [],
      smile: false,
      glasses: false,
      sunglasses: false,
      facialHair: false,
    };
    expect(describePhoto(t("en"), nothing)).toBeNull();
    expect(describePhoto(t("en"), { ...nothing, objects: ["cat"] })).toBe(
      "Automatic description: With a cat.",
    );
    expect(describePhoto(t("sv"), { ...nothing, people: 1, facialHair: true })).toBe(
      "Automatisk beskrivning: En person. Skägg eller mustasch.",
    );
  });
});
