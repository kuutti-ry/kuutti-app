import type { PhotoRejectionReason } from "@kuutti/schema";

/**
 * What the check does with each of Rekognition's moderation labels (#253,
 * ADR-006 §2, the maintainer's decisions of 12/10/2026). A hard group rejects
 * a photo when the check is sure and asks a person when it is not; an allowed
 * label never decides a photo (the tips may speak of it). The names are
 * Rekognition's content moderation taxonomy, version 7, every level of it,
 * read without regard to case; a name not listed is a label the check does
 * not know, and a person looks at it above `photo_moderation_label_threshold`.
 */
export type LabelGroup = "nudity" | "violence" | "disturbing" | "hate";

export const LABEL_GROUPS: readonly LabelGroup[] = ["nudity", "violence", "disturbing", "hate"];

/** The words the owner reads for a hard group (photos.rejected.*). */
export const GROUP_REASON: Record<LabelGroup, PhotoRejectionReason> = {
  nudity: "nudity",
  violence: "violence",
  disturbing: "other",
  hate: "other",
};

/** Each hard group's two lines in matching_config: from `review` a person looks, from `reject` the check decides. */
export const groupLineKeys = (group: LabelGroup) =>
  ({
    review: `photo_moderation_${group}_review`,
    reject: `photo_moderation_${group}_reject`,
  }) as const;

const HARD: Record<LabelGroup, readonly string[]> = {
  // Explicit, all of it; and nudity that is covered but still nudity.
  nudity: [
    "Explicit",
    "Explicit Nudity",
    "Exposed Male Genitalia",
    "Exposed Female Genitalia",
    "Exposed Buttocks or Anus",
    "Exposed Female Nipple",
    "Explicit Sexual Activity",
    "Sex Toys",
    "Implied Nudity",
    "Obstructed Intimate Parts",
    "Obstructed Female Nipple",
    "Obstructed Male Genitalia",
  ],
  // Weapons included, a hunting rifle too: the reason says "violence or weapons".
  violence: [
    "Violence",
    "Weapons",
    "Graphic Violence",
    "Weapon Violence",
    "Physical Violence",
    "Self-Harm",
    "Blood & Gore",
    "Explosions and Blasts",
  ],
  disturbing: [
    "Visually Disturbing",
    "Death and Emaciation",
    "Emaciated Bodies",
    "Corpses",
    "Crashes",
    "Air Crash",
  ],
  hate: ["Hate Symbols", "Nazi Party", "White Supremacy", "Extremist"],
};

/**
 * Never a reason to hold a photo back: a shirtless chest, a bare back,
 * swimwear, a kiss; alcohol, and drugs and tobacco (Rekognition cannot tell a
 * joint from a cigarette, nor medicine from vitamins); a middle finger;
 * gambling.
 */
const ALLOWED: readonly string[] = [
  "Non-Explicit Nudity of Intimate parts and Kissing",
  "Non-Explicit Nudity",
  "Bare Back",
  "Exposed Male Nipple",
  "Partially Exposed Buttocks",
  "Partially Exposed Female Breast",
  "Kissing on the Lips",
  "Swimwear or Underwear",
  "Female Swimwear or Underwear",
  "Male Swimwear or Underwear",
  "Drugs & Tobacco",
  "Products",
  "Pills",
  "Drugs & Tobacco Paraphernalia & Use",
  "Smoking",
  "Alcohol",
  "Alcohol Use",
  "Drinking",
  "Alcoholic Beverages",
  "Rude Gestures",
  "Middle Finger",
  "Gambling",
];

const BY_NAME: ReadonlyMap<string, LabelGroup | "allowed"> = new Map([
  ...LABEL_GROUPS.flatMap((group) =>
    HARD[group].map((name) => [name.toLowerCase(), group] as const),
  ),
  ...ALLOWED.map((name) => [name.toLowerCase(), "allowed"] as const),
]);

/** The group of a moderation label, `allowed`, or undefined for a name the check does not know. */
export const groupOf = (name: string): LabelGroup | "allowed" | undefined =>
  BY_NAME.get(name.toLowerCase());
