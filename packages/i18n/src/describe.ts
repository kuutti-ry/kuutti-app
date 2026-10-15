import type { PlainMessageKey, TFunction } from "./instance.ts";

/**
 * The automatic photo description in words (#296, ADR-006 §3). The API
 * stores and sends keys of a closed list, never a sentence (`PhotoDescription`
 * in packages/schema); this is the one place that turns them into text, in
 * the reader's language, for the photo's screen-reader label and the text
 * under it on the clients and for the words in the export on the API. The
 * order is the issue's: the people and the setting, then the face, then the
 * activity and objects, so a listener hears who and where before the rest.
 */

/** What the check saw, as the API sends it: keys, never words. */
export type PhotoDescriptionKeys = {
  people: number;
  setting: "indoors" | "outdoors" | null;
  scene: readonly string[];
  objects: readonly string[];
  smile: boolean;
  glasses: boolean;
  sunglasses: boolean;
  facialHair: boolean;
};

/** Which parts the reader wants (the Photo descriptions setting, #296 part 3); every part by default. */
export type PhotoDescriptionParts = { people: boolean; face: boolean; objects: boolean };

export const ALL_DESCRIPTION_PARTS: Readonly<PhotoDescriptionParts> = {
  people: true,
  face: true,
  objects: true,
};

/**
 * One sentence from phrases: the first with a capital, the rest after commas,
 * a full stop at the end. Each phrase is a whole fragment from messages.yaml,
 * so nothing here inflects. English, Finnish and Swedish all list with a
 * comma; a language that does not takes its separator from a key here.
 */
function sentence(phrases: readonly string[]): string | null {
  const [first, ...rest] = phrases;
  if (first === undefined) return null;
  const capital = first.charAt(0).toUpperCase() + first.slice(1);
  return `${[capital, ...rest].join(", ")}.`;
}

/**
 * The description as text, or null when the parts the reader asked for say
 * nothing: a photo of nobody indoors, with nothing seen, when the face is
 * not wanted. The text names itself as automatic, so nobody takes the
 * machine's words for the owner's.
 */
export function describePhoto(
  t: TFunction,
  description: PhotoDescriptionKeys,
  parts: Readonly<PhotoDescriptionParts> = ALL_DESCRIPTION_PARTS,
): string | null {
  const sentences: string[] = [];
  if (parts.people) {
    const where: string[] = [];
    if (description.people > 0) {
      where.push(t("photos.description.people", { people: description.people }));
    }
    if (description.setting) where.push(t(`photos.description.setting.${description.setting}`));
    for (const scene of description.scene) {
      // The keys are the schema's closed list, each with its entry below the
      // same name; the client drops a key it has no words for before this.
      where.push(t(`photos.description.scene.${scene}` as PlainMessageKey));
    }
    const said = sentence(where);
    if (said) sentences.push(said);
  }
  if (parts.face) {
    const face: string[] = [];
    if (description.smile) face.push(t("photos.description.face.smile"));
    if (description.glasses) face.push(t("photos.description.face.glasses"));
    if (description.sunglasses) face.push(t("photos.description.face.sunglasses"));
    if (description.facialHair) face.push(t("photos.description.face.facialHair"));
    const said = sentence(face);
    if (said) sentences.push(said);
  }
  if (parts.objects) {
    const said = sentence(
      description.objects.map((object) =>
        t(`photos.description.object.${object}` as PlainMessageKey),
      ),
    );
    if (said) sentences.push(said);
  }
  if (sentences.length === 0) return null;
  return t("photos.description.text", { description: sentences.join(" ") });
}
