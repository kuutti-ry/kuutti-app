import type { FaceDetail } from "@aws-sdk/client-rekognition";
import type { PlainMessageKey } from "@kuutti/i18n";
import {
  PHOTO_DESCRIPTION_OBJECTS_MAX,
  PHOTO_DESCRIPTION_SCENES_MAX,
  type PhotoDescription,
  type PhotoObject,
  type PhotoScene,
  type PhotoSetting,
} from "@kuutti/schema";

/**
 * The automatic photo description (#296, ADR-006 §1 and §3): what the photo
 * check sees in a photo, for everyone to hear with it. One rule writes the
 * list: say only what a sighted viewer sees, never what they would infer. So
 * the scene, an activity, an animal or an object, a smile, glasses, facial
 * hair; never body shape, attractiveness, age, gender, emotion, ethnicity or
 * hair length (the issue's table; age is the bank's and on the card, gender
 * is self-declared, the rest are inferences or desirability signals). The
 * same three Rekognition calls as before, asked for more by name: the face
 * attributes below, and DetectLabels filtered to the closed list here, whose
 * keys are the schema's enums and whose words are one messages.yaml entry
 * each (`photos.description.<part>.<key>`). Rekognition's names are the
 * taxonomy's of 2024 (AmazonRekognitionLabels_v3.0); the categories were
 * read too, and none of these is in Person Description or in Expressions
 * and Emotions. Left out on purpose, for the maintainer to add: drinks (a
 * false "beer" on a profile reads as a judgement), apparel beyond what the
 * face carries, Mirror and Bathroom (the owner's tip, #56; said to a viewer
 * they read as a judgement too).
 */

/** Indoors or outdoors, Rekognition's own two labels. */
const SETTING_LABELS: Readonly<Record<PhotoSetting, string>> = {
  indoors: "Indoors",
  outdoors: "Outdoors",
};

/** Where: the key of the schema, the label Rekognition is asked for. */
const SCENE_LABELS: Readonly<Record<PhotoScene, string>> = {
  lake: "Lake",
  sea: "Sea",
  beach: "Beach",
  river: "River",
  // Rekognition has no Forest; Woodland carries it as an alias.
  forest: "Woodland",
  mountain: "Mountain",
  snow: "Snow",
  ice: "Ice",
  field: "Field",
  park: "Park",
  garden: "Garden",
  countryside: "Countryside",
  city: "City",
  street: "Street",
  cafe: "Cafe",
  restaurant: "Restaurant",
  kitchen: "Kitchen",
  living_room: "Living Room",
  office: "Office",
  gym: "Gym",
  concert: "Concert",
  festival: "Festival",
  bar: "Bar",
  library: "Library",
  museum: "Museum",
  church: "Church",
  harbour: "Harbor",
  sauna: "Sauna",
  tent: "Tent",
  sunset: "Sunset",
  aurora: "Aurora",
};

/** What, and with what: the key of the schema, the label Rekognition is asked for. */
const OBJECT_LABELS: Readonly<Record<PhotoObject, string>> = {
  hiking: "Hiking",
  fishing: "Fishing",
  skiing: "Skiing",
  snowboarding: "Snowboarding",
  ice_skating: "Ice Skating",
  hockey: "Hockey",
  football: "Soccer",
  basketball: "Basketball",
  tennis: "Tennis",
  golf: "Golf",
  running: "Running",
  cycling: "Cycling",
  swimming: "Swimming",
  surfing: "Surfing",
  yoga: "Yoga",
  climbing: "Climbing",
  dancing: "Dancing",
  cooking: "Cooking",
  baking: "Baking",
  guitar: "Guitar",
  piano: "Piano",
  reading: "Reading",
  gardening: "Gardening",
  camping: "Camping",
  picnic: "Picnic",
  kayak: "Kayak",
  canoe: "Canoe",
  sailboat: "Sailboat",
  boat: "Boat",
  rowing: "Rowing",
  bicycle: "Bicycle",
  motorcycle: "Motorcycle",
  car: "Car",
  horse: "Horse",
  horse_riding: "Horseback Riding",
  dog: "Dog",
  cat: "Cat",
  fish: "Fish",
  coffee: "Coffee",
  flowers: "Flower",
  bonfire: "Bonfire",
};

/**
 * Every key of the closed list has its words in messages.yaml: a member
 * without `photos.description.<part>.<key>` fails to compile here, before any
 * photo is checked, so the list and the catalogue cannot drift apart.
 */
type DescriptionKey =
  | `photos.description.setting.${PhotoSetting}`
  | `photos.description.scene.${PhotoScene}`
  | `photos.description.object.${PhotoObject}`;
const _catalogued: DescriptionKey extends PlainMessageKey ? true : never = true;
void _catalogued;

/** Every name DetectLabels is asked for on the description's account: the closed list is the filter. */
export const DESCRIPTION_LABELS: readonly string[] = [
  ...Object.values(SETTING_LABELS),
  ...Object.values(SCENE_LABELS),
  ...Object.values(OBJECT_LABELS),
];

/**
 * What DetectFaces is asked for beside DEFAULT (the box, the confidence, the
 * quality): the sights a description says. Never ALL, which returns
 * everything below.
 */
export const FACE_ATTRIBUTES = [
  "DEFAULT",
  "SUNGLASSES",
  "SMILE",
  "EYEGLASSES",
  "BEARD",
  "MUSTACHE",
] as const;

/**
 * Never asked for and never read (#296 part 2's table): an inference about
 * the person, not a sight. moderation.test.ts holds every DetectFaces request
 * to this, and the description to what these would say even when an answer
 * carries them.
 */
export const NEVER_FACE_ATTRIBUTES = ["ALL", "GENDER", "AGE_RANGE", "EMOTIONS"] as const;

type Signal = { value: boolean; confidence: number };

/** The largest face's attributes as Rekognition answered them; false at zero where it said nothing. */
type FaceSignals = {
  smile: Signal;
  eyeglasses: Signal;
  sunglasses: Signal;
  beard: Signal;
  mustache: Signal;
};

/** What the description is made of, kept raw on the Inspection so the lines of matching_config apply at decision time. */
export type DescriptionSignals = {
  /** The scene labels of the closed list DetectLabels returned, with their confidences; others are dropped here. */
  scene: Array<{ name: string; confidence: number }>;
  /** The largest face's attributes, or null without a face. */
  face: FaceSignals | null;
};

export const NOTHING_SEEN: DescriptionSignals = { scene: [], face: null };

const NAME_TO_SETTING: ReadonlyMap<string, PhotoSetting> = new Map(
  (Object.entries(SETTING_LABELS) as [PhotoSetting, string][]).map(([key, name]) => [
    name.toLowerCase(),
    key,
  ]),
);
const NAME_TO_SCENE: ReadonlyMap<string, PhotoScene> = new Map(
  (Object.entries(SCENE_LABELS) as [PhotoScene, string][]).map(([key, name]) => [
    name.toLowerCase(),
    key,
  ]),
);
const NAME_TO_OBJECT: ReadonlyMap<string, PhotoObject> = new Map(
  (Object.entries(OBJECT_LABELS) as [PhotoObject, string][]).map(([key, name]) => [
    name.toLowerCase(),
    key,
  ]),
);
const DESCRIBED: ReadonlySet<string> = new Set([
  ...NAME_TO_SETTING.keys(),
  ...NAME_TO_SCENE.keys(),
  ...NAME_TO_OBJECT.keys(),
]);

/** The face that fills most of the frame: the person the photo is of, as the tips read it too (#56). */
export function largestFace(faces: ReadonlyArray<FaceDetail>): FaceDetail | undefined {
  let largest: FaceDetail | undefined;
  let largestArea = 0;
  for (const face of faces) {
    const area = (face.BoundingBox?.Width ?? 0) * (face.BoundingBox?.Height ?? 0);
    if (area >= largestArea) {
      largestArea = area;
      largest = face;
    }
  }
  return largest;
}

const signal = (attribute: { Value?: boolean; Confidence?: number } | undefined): Signal => ({
  value: attribute?.Value === true,
  confidence: attribute?.Confidence ?? 0,
});

/**
 * The raw material of a description from Rekognition's two answers, pure.
 * Only names of the closed list are kept from the scene, read without regard
 * to case; of the face, only the five attributes asked for. An answer that
 * carries more (Gender, AgeRange, Emotions: never asked for, but an answer is
 * an answer) leaves nothing here, which the never-list test proves.
 */
export function descriptionSignalsFrom(
  scene: ReadonlyArray<{ Name?: string; Confidence?: number }>,
  faces: ReadonlyArray<FaceDetail>,
): DescriptionSignals {
  const kept: DescriptionSignals["scene"] = [];
  for (const label of scene) {
    if (typeof label.Name !== "string" || !DESCRIBED.has(label.Name.toLowerCase())) continue;
    kept.push({ name: label.Name, confidence: label.Confidence ?? 0 });
  }
  const face = largestFace(faces);
  return {
    scene: kept,
    face: face
      ? {
          smile: signal(face.Smile),
          eyeglasses: signal(face.Eyeglasses),
          sunglasses: signal(face.Sunglasses),
          beard: signal(face.Beard),
          mustache: signal(face.Mustache),
        }
      : null,
  };
}

/** The keys of one kind at or above the line, the surest first, at most `max`; a name twice counts once. */
function keysAbove<K extends string>(
  scene: DescriptionSignals["scene"],
  byName: ReadonlyMap<string, K>,
  line: number,
  max: number,
): K[] {
  const best = new Map<K, number>();
  for (const label of scene) {
    const key = byName.get(label.name.toLowerCase());
    if (key === undefined || label.confidence < line) continue;
    if ((best.get(key) ?? -1) < label.confidence) best.set(key, label.confidence);
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([key]) => key);
}

/**
 * The description, pure: `people` is the faces the check counted (the face
 * threshold of ADR-006 §2, so an approved photo says one), the setting is
 * Indoors or Outdoors where the check is at least `confidenceMin` sure (the
 * surer where it says both), the scene and the objects are the closed list's
 * keys at or above the line, the surest first and a few at most, and the face
 * says what it is that sure of. Facial hair is a beard or a moustache, never
 * which. The line is matching_config photo_description_confidence_min.
 */
export function photoDescriptionOf(
  seen: DescriptionSignals,
  people: number,
  confidenceMin: number,
): PhotoDescription {
  const [setting = null] = keysAbove(seen.scene, NAME_TO_SETTING, confidenceMin, 1);
  const sure = (attribute: Signal | undefined): boolean =>
    attribute?.value === true && attribute.confidence >= confidenceMin;
  return {
    people,
    setting,
    scene: keysAbove(seen.scene, NAME_TO_SCENE, confidenceMin, PHOTO_DESCRIPTION_SCENES_MAX),
    objects: keysAbove(seen.scene, NAME_TO_OBJECT, confidenceMin, PHOTO_DESCRIPTION_OBJECTS_MAX),
    smile: sure(seen.face?.smile),
    glasses: sure(seen.face?.eyeglasses),
    sunglasses: sure(seen.face?.sunglasses),
    facialHair: sure(seen.face?.beard) || sure(seen.face?.mustache),
  };
}
