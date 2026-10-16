import { z } from "zod";

/**
 * Photos (#48, TD-2, TD-8). Every upload goes through the API (rule 4): the
 * app pre-resizes and sends the bytes as multipart, the API re-encodes them
 * into three WebP variants under a content-addressed key and discards the
 * original. Nothing here names the object key or the bucket: the app asks for
 * a variant and receives a short-lived signed URL.
 */

export const PhotoId = z.uuid().brand<"PhotoId">().meta({ id: "PhotoId" });
export type PhotoId = z.infer<typeof PhotoId>;

/** thumb in lists, card on open, full on zoom only (rules/mobile.md Images). */
export const PHOTO_VARIANTS = ["thumb", "card", "full"] as const;
export const PhotoVariant = z.enum(PHOTO_VARIANTS).meta({
  id: "PhotoVariant",
  description:
    "thumb: 200×200 for lists. card: 800×1067 when a profile is opened. full: 1600 px long edge, requested only from the zoom screen.",
});
export type PhotoVariant = z.infer<typeof PhotoVariant>;

/** The variants the pipeline makes; the API is the only writer, so the sizes are contract, not configuration. */
export const PHOTO_VARIANT_SIZES = {
  thumb: { width: 200, height: 200 },
  card: { width: 800, height: 1067 },
  full: { longEdge: 1600 },
} as const;

/**
 * pending: uploaded, seen by its owner only, until moderation (#49) decides.
 * approved: may be shown to others. queued: waiting for a human moderator.
 * rejected: a human said no; the owner is told why in words.
 */
export const PhotoState = z.enum(["pending", "approved", "queued", "rejected"]).meta({
  id: "PhotoState",
});
export type PhotoState = z.infer<typeof PhotoState>;

/** The upload's size cap (rules/api.md Media): checked on the Content-Length before any byte is read. */
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
/** Refused from the file header before the decoder runs; the app sends 1600 px, so this is a backstop. */
export const PHOTO_MAX_INPUT_PIXELS = 30_000_000;
/** What the API decodes. An animated GIF is refused, never reduced to a frame. */
const PHOTO_INPUT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const PhotoUploadRequest = z
  .object({
    photo: z
      .file()
      .max(PHOTO_MAX_BYTES)
      .mime([...PHOTO_INPUT_TYPES])
      .meta({
        // The document generator has no mapping for a file schema; this is what it should say.
        type: "string",
        format: "binary",
        description: "The picture, pre-resized to 1600 px by the app; JPEG, PNG or WebP.",
      }),
  })
  .strict()
  .meta({ id: "PhotoUploadRequest" });
export type PhotoUploadRequest = z.infer<typeof PhotoUploadRequest>;

/**
 * Why a moderator said no (#49): a closed list the owner is told in words,
 * never the label names behind it.
 */
export const PhotoRejectionReason = z
  .enum(["nudity", "no_person", "several_people", "minor", "violence", "contact_details", "other"])
  .meta({ id: "PhotoRejectionReason" });
export type PhotoRejectionReason = z.infer<typeof PhotoRejectionReason>;

/**
 * The hard groups of the automatic check (#253): what a photo it did not show
 * to others may have shown. Kept as a note for twelve months, read by the
 * person in their export and by nobody else.
 */
export const PhotoCheckKind = z
  .enum(["nudity", "violence", "disturbing", "hate"])
  .meta({ id: "PhotoCheckKind" });
export type PhotoCheckKind = z.infer<typeof PhotoCheckKind>;

/**
 * The line an owner picks for a photo (#296): a key from this closed list,
 * never the person's text, shown to every viewer in their own language
 * (photos.caption.<key> in messages.yaml), the way the bio's ready lines
 * work. No line claims anything about the photo's editing or the person's
 * looks, and none names a second person: a photo shows its owner alone
 * (ADR-006 §2).
 */
export const PHOTO_CAPTIONS = [
  "recent",
  "old_favourite",
  "found_again",
  "friends_chose",
  "someone_else_took",
  "everyday_me",
  "in_my_element",
  "favourite_place",
  "travelling",
  "summer_day",
  "winter_day",
  "four_legged",
  "at_work",
  "my_hobby",
  "proud_of",
  "ask_me",
] as const;
export const PhotoCaption = z.enum(PHOTO_CAPTIONS).meta({ id: "PhotoCaption" });
export type PhotoCaption = z.infer<typeof PhotoCaption>;

/**
 * The automatic description of a photo (#296, ADR-006 §1 and §3): what the
 * photo check sees in it, said only where a sighted viewer sees it too and
 * never what they would infer. Structured, never a sentence: each key names
 * a messages.yaml entry (`photos.description.<part>.<key>`), so every viewer
 * reads it in their own language, and the closed list is also the catalogue.
 * The Rekognition names behind the keys are the API's
 * (`apps/api/src/media/description.ts`). Nothing here is body shape,
 * attractiveness, age, gender, emotion, ethnicity or hair: the check is never
 * asked for those.
 */
export const PHOTO_SETTINGS = ["indoors", "outdoors"] as const;
export const PhotoSetting = z.enum(PHOTO_SETTINGS).meta({ id: "PhotoSetting" });
export type PhotoSetting = z.infer<typeof PhotoSetting>;

/** Where the photo was taken, as far as the check can see it. */
export const PHOTO_SCENES = [
  "lake",
  "sea",
  "beach",
  "river",
  "forest",
  "mountain",
  "snow",
  "ice",
  "field",
  "park",
  "garden",
  "countryside",
  "city",
  "street",
  "cafe",
  "restaurant",
  "kitchen",
  "living_room",
  "office",
  "gym",
  "concert",
  "festival",
  "bar",
  "library",
  "museum",
  "church",
  "harbour",
  "sauna",
  "tent",
  "sunset",
  "aurora",
] as const;
export const PhotoScene = z.enum(PHOTO_SCENES).meta({ id: "PhotoScene" });
export type PhotoScene = z.infer<typeof PhotoScene>;

/** What the person is doing, or what is with them: an activity, an animal, an object. */
export const PHOTO_OBJECTS = [
  "hiking",
  "fishing",
  "skiing",
  "snowboarding",
  "ice_skating",
  "hockey",
  "football",
  "basketball",
  "tennis",
  "golf",
  "running",
  "cycling",
  "swimming",
  "surfing",
  "yoga",
  "climbing",
  "dancing",
  "cooking",
  "baking",
  "guitar",
  "piano",
  "reading",
  "gardening",
  "camping",
  "picnic",
  "kayak",
  "canoe",
  "sailboat",
  "boat",
  "rowing",
  "bicycle",
  "motorcycle",
  "car",
  "horse",
  "horse_riding",
  "dog",
  "cat",
  "fish",
  "coffee",
  "flowers",
  "bonfire",
] as const;
export const PhotoObject = z.enum(PHOTO_OBJECTS).meta({ id: "PhotoObject" });
export type PhotoObject = z.infer<typeof PhotoObject>;

/** How many scene and object keys a description carries at most, the surest first; more is noise read aloud. */
export const PHOTO_DESCRIPTION_SCENES_MAX = 3;
export const PHOTO_DESCRIPTION_OBJECTS_MAX = 4;

export const PhotoDescription = z
  .object({
    people: z.int().min(0).max(50).meta({
      description: "Faces the check counted as people present (the face threshold of ADR-006 §2).",
    }),
    setting: PhotoSetting.nullable().meta({
      description: "Indoors or outdoors when the check is sure enough of one; null otherwise.",
    }),
    scene: z.array(PhotoScene).max(PHOTO_DESCRIPTION_SCENES_MAX).meta({
      description: "Where, the surest first; each a key of photos.description.scene.",
    }),
    objects: z.array(PhotoObject).max(PHOTO_DESCRIPTION_OBJECTS_MAX).meta({
      description:
        "Activities, animals and objects, the surest first; each a key of photos.description.object.",
    }),
    smile: z.boolean(),
    glasses: z.boolean(),
    sunglasses: z.boolean(),
    facialHair: z.boolean().meta({ description: "A beard or a moustache." }),
  })
  .meta({
    id: "PhotoDescription",
    description:
      "What the photo check sees in the photo, as keys the client renders in the viewer's language (#296). Read with the photo by screen readers, after the owner's caption; shown under it when the viewer asks.",
  });
export type PhotoDescription = z.infer<typeof PhotoDescription>;

/**
 * A description as this build can say it: a scene or object key it has no
 * words for is left out, so a newer API's label never locks an older app out
 * of its photos (the way readPhotoList treats the tips). Applied by a client
 * before it parses the photo; anything that is not a description is handed
 * back as it is, for the parse to refuse.
 */
export function knownPhotoDescription(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const { scene, objects } = value as { scene?: unknown; objects?: unknown };
  return {
    ...value,
    scene: Array.isArray(scene) ? scene.filter((key) => PhotoScene.safeParse(key).success) : scene,
    objects: Array.isArray(objects)
      ? objects.filter((key) => PhotoObject.safeParse(key).success)
      : objects,
  };
}

/** A photo, the owner's or a card's, with its description as this build can say it; anything else is handed back as it is. */
export function photoWithKnownDescription(photo: unknown): unknown {
  if (photo === null || typeof photo !== "object" || Array.isArray(photo)) return photo;
  const { description } = photo as { description?: unknown };
  if (description === undefined) return photo;
  return { ...photo, description: knownPhotoDescription(description) };
}

/** What the owner knows about one of their photos. Never the key, never a URL. */
export const Photo = z
  .object({
    id: PhotoId,
    blurhash: z.string().min(6).max(200).meta({
      description: "Placeholder the app paints before the thumb arrives (computed from the thumb).",
    }),
    width: z.int().positive().meta({ description: "Of the full variant." }),
    height: z.int().positive().meta({ description: "Of the full variant." }),
    state: PhotoState,
    rejectionReason: PhotoRejectionReason.nullable().meta({
      description: "Set when state is rejected: the reason the owner is told.",
    }),
    appealable: z.boolean().meta({
      description:
        "The check rejected it and the owner may ask a person to look, once (POST /photos/{id}/appeal); never after sure nudity or a person's decision.",
    }),
    position: z.int().min(0).meta({
      description:
        "0 is first in the owner's order; the main photo is the first approved one (ADR-009 §4).",
    }),
    createdAt: z.iso.datetime(),
    caption: PhotoCaption.nullable().default(null).meta({
      description:
        "The line the owner picked for the photo (#296), or null; the words for it are the client's, per language. Null when absent, so an app that is newer than its API still reads the answer.",
    }),
    description: PhotoDescription.nullable().default(null).meta({
      description:
        "What the photo check saw in the photo (#296), or null before the check ran or where none runs. Null when absent, so an app that is newer than its API still reads the answer.",
    }),
  })
  .meta({ id: "Photo" });
export type Photo = z.infer<typeof Photo>;

/**
 * Advisory tips for the owner about their photos (#56; on the photo list
 * since #287). One tip at a time; never gates completeness, moderation, or
 * matching. A kind names what was noticed; the words for it are the
 * client's. Order of the enum is not priority: the tips rule of apps/api
 * holds that.
 */
export const TipKind = z
  .enum([
    "sunglasses",
    "mirror_selfie",
    "tight_crop",
    "group_photo",
    "poor_lighting",
    "blurry",
    "few_photos",
    // #253: the main photo shows a lot of skin; the main photo has a fish.
    "revealing",
    "fish",
  ])
  .meta({ id: "TipKind" });
export type TipKind = z.infer<typeof TipKind>;

/**
 * The fish the fish tip may name (#253): the species of Finland and nearby
 * waters that Rekognition has a label for. A species it knows from elsewhere
 * (tuna, sturgeon) is never named, however sure it is.
 */
export const FishSpecies = z
  .enum(["pike", "perch", "salmon", "trout", "carp", "eel", "cod", "herring", "halibut"])
  .meta({ id: "FishSpecies" });
export type FishSpecies = z.infer<typeof FishSpecies>;

export const PhotoList = z
  .object({
    photos: z.array(Photo).max(50),
    maxPhotos: z.int().positive().meta({ description: "matching_config max_photos." }),
    /** The tips that apply, highest priority first; the app shows one at a time, by the main photo. */
    tips: z.array(TipKind),
    /**
     * With the fish tip, the species the check is sure enough of on the main
     * photo; null without the tip or without a sure species. Null when absent,
     * so an app that is newer than its API still reads the answer.
     */
    fishSpecies: FishSpecies.nullable().default(null),
  })
  .meta({ id: "PhotoList" });
export type PhotoList = z.infer<typeof PhotoList>;

/** Every photo of the account exactly once, in the wanted order. */
export const PhotoOrderRequest = z
  .object({ order: z.array(PhotoId).min(1).max(50) })
  .strict()
  .meta({ id: "PhotoOrderRequest" });
export type PhotoOrderRequest = z.infer<typeof PhotoOrderRequest>;

/** The owner's line for a photo (#296), or null to clear it. */
export const PhotoCaptionRequest = z
  .object({ caption: PhotoCaption.nullable() })
  .strict()
  .meta({ id: "PhotoCaptionRequest" });
export type PhotoCaptionRequest = z.infer<typeof PhotoCaptionRequest>;

export const PhotoParams = z.object({ id: PhotoId }).meta({ id: "PhotoParams" });
export const PhotoVariantParams = z
  .object({ id: PhotoId, variant: PhotoVariant })
  .meta({ id: "PhotoVariantParams" });

/** A signed URL, good for fifteen minutes. Never a cache key: the app caches by photoId/variant. */
export const PhotoUrlResponse = z
  .object({
    url: z.url(),
    variant: PhotoVariant,
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: "PhotoUrlResponse" });
export type PhotoUrlResponse = z.infer<typeof PhotoUrlResponse>;

/** The shape of matching_config.photo_fetches_per_day (#52, TD-6): signed URLs per variant per Finnish day. */
export const PhotoFetchBudget = z
  .object({ thumb: z.int().min(0), card: z.int().min(0), full: z.int().min(0) })
  .strict();
export type PhotoFetchBudget = z.infer<typeof PhotoFetchBudget>;
