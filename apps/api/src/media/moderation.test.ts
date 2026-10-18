import {
  DetectFacesCommand,
  DetectLabelsCommand,
  type DetectModerationLabelsCommand,
  type RekognitionClient,
} from "@aws-sdk/client-rekognition";
import { CardPreviewResponse, Photo, PhotoDescription, PhotoList } from "@kuutti/schema";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { closerLookOf } from "../safety/index.ts";
import { signedInAccount, staffSession, withMatchingConfig } from "../test/account.ts";
import { openExport } from "../test/export.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { fixtureJpeg, fixtureWebp, testMediaDeps } from "../test/media.ts";
import {
  DESCRIPTION_LABELS,
  type DescriptionSignals,
  descriptionSignalsFrom,
  FACE_ATTRIBUTES,
  NEVER_FACE_ATTRIBUTES,
  NOTHING_SEEN,
  photoDescriptionOf,
} from "./description.ts";
import {
  closerLines,
  decideMessagePhoto,
  decideModeration,
  type Inspection,
  type Moderator,
  moderatePhoto,
  NO_FACE,
  NOT_CHECKED,
  queueAllModerator,
  RECHECK_AFTER_MS,
  rekognitionModerator,
  storedLabels,
  sweepPendingPhotos,
  type Thresholds,
  tipLabelsFrom,
} from "./moderation.ts";
import { objectKey } from "./store.ts";

// The automatic check (#49, features/media/moderation.feature): the decision
// is pure and tested over the rows of the outline; the rest runs through the
// upload with a moderator that answers what Rekognition would, recorded, and
// never a real call.

const inspection = (
  labels: string,
  faces: string,
  tipLabels: Inspection["tipLabels"] = [],
  seen: DescriptionSignals = NOTHING_SEEN,
): Inspection => ({
  checked: labels !== "unchecked",
  labels:
    labels === "none" || labels === "unchecked"
      ? []
      : labels.split(",").map((part) => {
          const match = /^\s*(.+?)\s+(\d+)\s*$/.exec(part);
          if (!match) throw new Error(`bad label ${part}`);
          return { name: match[1] ?? "", parentName: "", confidence: Number(match[2]) };
        }),
  tipLabels,
  faceConfidences: faces === "none" ? [] : faces.split(",").map(Number),
  seen,
  modelVersion: "7.0",
  calls: 3,
});

/** Migration 0030's lines for every hard group, the given lines for unknown labels and faces, and 0045's for the description. */
const lines = (labelThreshold: number, faceThreshold: number): Thresholds => ({
  labelThreshold,
  faceThreshold,
  groups: {
    nudity: { review: 60, reject: 90 },
    violence: { review: 60, reject: 90 },
    disturbing: { review: 60, reject: 90 },
    hate: { review: 60, reject: 90 },
  },
  noAppealNudity: 95,
  descriptionConfidenceMin: 80,
});

/** What a lakeside hiker's photo would come back as: the material of a description (#296). */
const LAKESIDE: DescriptionSignals = {
  scene: [
    { name: "Outdoors", confidence: 99 },
    { name: "Lake", confidence: 95 },
    { name: "Hiking", confidence: 91 },
    { name: "Dog", confidence: 88 },
    { name: "Woodland", confidence: 70 },
  ],
  face: {
    smile: { value: true, confidence: 97 },
    eyeglasses: { value: false, confidence: 99 },
    sunglasses: { value: true, confidence: 93 },
    beard: { value: false, confidence: 90 },
    mustache: { value: false, confidence: 90 },
  },
};
const LAKESIDE_DESCRIPTION: PhotoDescription = {
  people: 1,
  setting: "outdoors",
  scene: ["lake"],
  objects: ["hiking", "dog"],
  smile: true,
  glasses: false,
  sunglasses: true,
  facialHair: false,
};

// A photo sent in a conversation (#350): the hard groups decide as for a
// profile photo, the face rules not at all, and nothing the check is sure
// of is appealable, since nothing of it is stored.
describe("Automatic decision on a photo sent in a conversation", () => {
  it.each([
    ["none", "none", "approved", "nothing", "none"],
    ["none", "99, 98, 95", "approved", "nothing", "none"],
    ["none", "70", "approved", "nothing", "none"],
    ["Female Swimwear or Underwear 99", "99", "approved", "nothing", "none"],
    ["Explicit Nudity 97", "99", "rejected", "Explicit Nudity", "nudity"],
    ["Explicit Nudity 75", "none", "queued", "Explicit Nudity", "none"],
    ["Weapons 93", "none", "rejected", "Weapons", "violence"],
    ["Corpses 95", "none", "rejected", "Corpses", "other"],
    ["unchecked", "none", "queued", NOT_CHECKED, "none"],
  ])("labels %s, faces %s → %s (%s, %s)", (labels, faces, outcome, flagged, reason) => {
    const decided = decideMessagePhoto(inspection(labels, faces), lines(60, 90));
    expect(decided.decision).toBe(outcome);
    expect(decided.flagged).toEqual(flagged === "nothing" ? [] : flagged.split(", "));
    expect(decided.reason).toBe(reason === "none" ? undefined : reason);
    expect(decided.appealable).toBeUndefined();
  });
});

describe("Automatic moderation decision", () => {
  it.each([
    ["none", "99", 60, 90, "approved", "nothing", "none"],
    // A hard group decides at its reject line and asks a person between its lines (#253).
    ["Explicit Nudity 97", "99", 60, 90, "rejected", "Explicit Nudity", "nudity"],
    ["Explicit Nudity 75", "99", 60, 90, "queued", "Explicit Nudity", "none"],
    ["Exposed Male Genitalia 95", "none", 60, 90, "rejected", "Exposed Male Genitalia", "nudity"],
    ["Implied Nudity 92", "99", 60, 90, "rejected", "Implied Nudity", "nudity"],
    // Shirtless, swimwear, smoking, a drink, a gesture: never a reason.
    ["Bare Back 98, Exposed Male Nipple 97", "99", 60, 90, "approved", "nothing", "none"],
    ["Female Swimwear or Underwear 99", "99", 60, 90, "approved", "nothing", "none"],
    ["Weapons 93", "99", 60, 90, "rejected", "Weapons", "violence"],
    ["Hate Symbols 91", "99", 60, 90, "rejected", "Hate Symbols", "other"],
    ["Corpses 95", "99", 60, 90, "rejected", "Corpses", "other"],
    [
      "Smoking 99, Alcoholic Beverages 98, Middle Finger 97",
      "99",
      60,
      90,
      "approved",
      "nothing",
      "none",
    ],
    // A label the check does not know goes to a person from labelThreshold.
    ["Suggestive 45", "99", 60, 90, "approved", "nothing", "none"],
    ["Suggestive 45", "99", 40, 90, "queued", "Suggestive", "none"],
    // No face at all is the check's own rejection (#253); a face it is unsure of goes to a person.
    ["none", "none", 60, 90, "rejected", NO_FACE, "no_person"],
    ["Explicit Nudity 75", "none", 60, 90, "rejected", `Explicit Nudity, ${NO_FACE}`, "no_person"],
    ["none", "70", 60, 90, "queued", NO_FACE, "none"],
    // Several faces are not accepted, by the check and not a person (#206);
    // a second face under the face threshold is not sure enough to count.
    ["none", "99, 98, 95", 60, 90, "rejected", "several_faces", "several_people"],
    ["none", "99, 70", 60, 90, "approved", "nothing", "none"],
    // A sure label names the reason before the faces do, and nudity before the rest.
    ["Explicit Nudity 97", "99, 98", 60, 90, "rejected", "Explicit Nudity", "nudity"],
    [
      "Violence 80, Explicit Nudity 61",
      "99",
      60,
      90,
      "queued",
      "Violence, Explicit Nudity",
      "none",
    ],
    [
      "Weapons 95, Explicit Nudity 92",
      "99",
      60,
      90,
      "rejected",
      "Weapons, Explicit Nudity",
      "nudity",
    ],
    ["unchecked", "none", 60, 90, "queued", NOT_CHECKED, "none"],
  ])(
    "labels %s, faces %s, thresholds %d/%d → %s (%s, %s)",
    (labels, faces, labelThreshold, faceThreshold, outcome, flagged, reason) => {
      const decided = decideModeration(
        inspection(labels, faces),
        lines(labelThreshold, faceThreshold),
      );
      expect(decided.decision).toBe(outcome);
      expect(decided.flagged).toEqual(flagged === "nothing" ? [] : flagged.split(", "));
      // The check names a reason only when it rejects.
      expect(decided.reason).toBe(reason === "none" ? undefined : reason);
    },
  );

  it("flags each label name once however many labels share it", () => {
    const decided = decideModeration(
      inspection("Suggestive 70, Suggestive 65", "99"),
      lines(60, 90),
    );
    expect(decided.flagged).toEqual(["Suggestive"]);
  });

  it("ignores tip signals when deciding the queue", () => {
    const decided = decideModeration(
      inspection("none", "99", [
        { name: "Mirror", parentName: "", confidence: 99 },
        { name: "TightCrop", parentName: "Face", confidence: 80 },
      ]),
      lines(60, 90),
    );
    expect(decided).toEqual({ decision: "approved", flagged: [], faces: 1 });
  });
});

describe("whether the owner may appeal the check's rejection (#253)", () => {
  it.each([
    ["none", "none", true],
    ["none", "99, 98", true],
    ["Weapons 99", "99", true],
    ["Explicit Nudity 92", "99", true],
    ["Explicit Nudity 95", "99", false],
    ["Exposed Male Genitalia 97", "none", false],
  ])("labels %s, faces %s → appealable %s", (labels, faces, appealable) => {
    const decided = decideModeration(inspection(labels, faces), lines(60, 90));
    expect(decided.decision).toBe("rejected");
    expect(decided.appealable).toBe(appealable);
  });

  it("names no appeal for what the check approves or queues", () => {
    expect(decideModeration(inspection("none", "99"), lines(60, 90)).appealable).toBeUndefined();
    expect(
      decideModeration(inspection("Explicit Nudity 75", "99"), lines(60, 90)).appealable,
    ).toBeUndefined();
  });
});

describe("tip signals for photo_review", () => {
  it("maps scene labels and face attributes without inventing Gender", () => {
    expect(
      tipLabelsFrom(
        [{ Name: "Mirror", Parents: [{ Name: "Furniture" }], Confidence: 88.4 }],
        [
          {
            Confidence: 99,
            BoundingBox: { Width: 0.7, Height: 0.7, Left: 0.1, Top: 0.1 },
            Sunglasses: { Value: true, Confidence: 91 },
            Quality: { Brightness: 40.2, Sharpness: 12.5 },
          },
          { Confidence: 80, BoundingBox: { Width: 0.1, Height: 0.1 } },
        ],
      ),
    ).toEqual([
      { name: "Mirror", parentName: "Furniture", confidence: 88.4 },
      { name: "Sunglasses", parentName: "Face", confidence: 91 },
      { name: "TightCrop", parentName: "Face", confidence: 49 },
      { name: "Brightness", parentName: "Face", confidence: 40.2 },
      { name: "Sharpness", parentName: "Face", confidence: 12.5 },
    ]);
  });

  it("caps the face area at the whole frame", () => {
    expect(
      tipLabelsFrom([], [{ Confidence: 99, BoundingBox: { Width: 1.2, Height: 1.1 } }]),
    ).toEqual([{ name: "TightCrop", parentName: "Face", confidence: 100 }]);
  });

  it("stores moderation labels ahead of tip signals, capped", () => {
    const labels = Array.from({ length: 48 }, (_, i) => ({
      name: `M${i}`,
      parentName: "",
      confidence: 50,
    }));
    const tipLabels = [
      { name: "Mirror", parentName: "", confidence: 90 },
      { name: "Bathroom", parentName: "", confidence: 80 },
      { name: "TightCrop", parentName: "Face", confidence: 40 },
    ];
    expect(storedLabels({ ...inspection("none", "99", tipLabels), labels })).toHaveLength(50);
    expect(storedLabels({ ...inspection("none", "99", tipLabels), labels }).at(-1)?.name).toBe(
      "Bathroom",
    );
  });
});

describe("The Rekognition adapter", () => {
  it("sends the card variant as JPEG, since Rekognition reads JPEG and PNG only", async () => {
    // The stored card is WebP (ADR-005 §2); on staging Rekognition answered
    // InvalidImageFormatException to it (09/10/2026, ADR-006 History).
    const sent: { command: string; bytes: Uint8Array }[] = [];
    const client = {
      async send(
        command: DetectModerationLabelsCommand | DetectFacesCommand | DetectLabelsCommand,
      ) {
        sent.push({
          command: command.constructor.name,
          bytes: command.input.Image?.Bytes ?? new Uint8Array(),
        });
        if (command instanceof DetectFacesCommand) {
          return { FaceDetails: [{ Confidence: 99.5 }] };
        }
        if (command instanceof DetectLabelsCommand) {
          return { Labels: [] };
        }
        return { ModerationLabels: [], ModerationModelVersion: "7.0" };
      },
    };
    const inspection = await rekognitionModerator(client as unknown as RekognitionClient).inspect(
      await fixtureWebp(800, 1067),
    );
    expect(sent.map((s) => s.command).sort()).toEqual([
      "DetectFacesCommand",
      "DetectLabelsCommand",
      "DetectModerationLabelsCommand",
    ]);
    for (const { bytes } of sent) {
      // JPEG starts with the SOI marker and the first segment marker, and
      // carries no metadata: Rekognition receives pixels only (rule 4).
      expect(Array.from(bytes.subarray(0, 3))).toEqual([0xff, 0xd8, 0xff]);
      const metadata = await sharp(bytes).metadata();
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect([metadata.width, metadata.height]).toEqual([800, 1067]);
    }
    expect(inspection).toMatchObject({
      checked: true,
      labels: [],
      tipLabels: [],
      faceConfidences: [99.5],
      calls: 3,
    });
  });

  it.each([
    { picture: [60, 40], sent: [80, 80] },
    { picture: [1600, 30], sent: [1600, 80] },
    { picture: [80, 80], sent: [80, 80] },
  ])(
    "pads a $picture.0×$picture.1 picture to $sent.0×$sent.1, since Rekognition refuses a side under 80 px (#350)",
    async ({ picture, sent }) => {
      // A message photo's full size keeps a small picture small; padding,
      // not scaling, so a long thin one does not grow.
      const sizes: number[][] = [];
      const client = {
        async send(command: DetectModerationLabelsCommand) {
          const metadata = await sharp(command.input.Image?.Bytes).metadata();
          sizes.push([metadata.width ?? 0, metadata.height ?? 0]);
          return {};
        },
      };
      await rekognitionModerator(client as unknown as RekognitionClient).inspect(
        await fixtureWebp(picture[0] ?? 0, picture[1] ?? 0),
      );
      expect(sizes).toEqual([sent, sent, sent]);
    },
  );

  it("decides without the scene when DetectLabels fails, and never asks the scene for sunglasses", async () => {
    let filters: string[] | undefined;
    const client = {
      async send(
        command: DetectModerationLabelsCommand | DetectFacesCommand | DetectLabelsCommand,
      ) {
        if (command instanceof DetectLabelsCommand) {
          filters = command.input.Settings?.GeneralLabels?.LabelInclusionFilters;
          throw new Error("AccessDeniedException");
        }
        if (command instanceof DetectFacesCommand) {
          return {
            FaceDetails: [{ Confidence: 99.5, Sunglasses: { Value: true, Confidence: 97 } }],
          };
        }
        return { ModerationLabels: [], ModerationModelVersion: "7.0" };
      },
    };
    const inspection = await rekognitionModerator(client as unknown as RekognitionClient).inspect(
      await fixtureWebp(800, 1067),
    );
    // The tips' scene labels, the species the fish tip may name (#253), and
    // the description's closed list (#296), each name once.
    expect(filters).toEqual(
      expect.arrayContaining([
        "Mirror",
        "Bathroom",
        "Fish",
        "Fishing",
        "Pike",
        "Perch",
        "Salmon",
        "Trout",
        "Carp",
        "Eel",
        "Cod",
        "Herring",
        "Halibut",
        ...DESCRIPTION_LABELS,
      ]),
    );
    expect(new Set(filters).size).toBe(filters?.length);
    expect(inspection).toMatchObject({
      checked: true,
      labels: [],
      tipLabels: [{ name: "Sunglasses", parentName: "Face", confidence: 97 }],
      faceConfidences: [99.5],
      // The face's sunglasses are the description's too; the scene said nothing.
      seen: {
        scene: [],
        face: expect.objectContaining({ sunglasses: { value: true, confidence: 97 } }),
      },
      calls: 2,
    });
  });

  it("The check asks the face for what a sighted viewer sees and never for gender, age or emotion", async () => {
    let attributes: string[] | undefined;
    let settings: Record<string, unknown> | undefined;
    const client = {
      async send(
        command: DetectModerationLabelsCommand | DetectFacesCommand | DetectLabelsCommand,
      ) {
        if (command instanceof DetectFacesCommand) {
          attributes = command.input.Attributes;
          // An answer that carries what was never asked for: Rekognition's
          // whole FaceDetail, as ALL would return it.
          return {
            FaceDetails: [
              {
                Confidence: 99,
                BoundingBox: { Width: 0.5, Height: 0.5, Left: 0.2, Top: 0.2 },
                Smile: { Value: true, Confidence: 96 },
                Eyeglasses: { Value: true, Confidence: 91 },
                Sunglasses: { Value: false, Confidence: 99 },
                Beard: { Value: true, Confidence: 85 },
                Mustache: { Value: false, Confidence: 97 },
                Gender: { Value: "Female", Confidence: 99 },
                AgeRange: { Low: 25, High: 35 },
                Emotions: [{ Type: "HAPPY", Confidence: 98 }],
                EyesOpen: { Value: true, Confidence: 99 },
                MouthOpen: { Value: false, Confidence: 95 },
              },
            ],
          };
        }
        if (command instanceof DetectLabelsCommand) {
          settings = command.input.Settings?.GeneralLabels as Record<string, unknown>;
          return {
            Labels: [
              { Name: "Indoors", Confidence: 92 },
              { Name: "Kitchen", Confidence: 90 },
              { Name: "Cooking", Confidence: 86 },
              // Never asked for; dropped on arrival even when it comes.
              { Name: "Adult", Confidence: 99 },
              { Name: "Female", Confidence: 99 },
            ],
          };
        }
        return { ModerationLabels: [], ModerationModelVersion: "7.0" };
      },
    };
    const seen = await rekognitionModerator(client as unknown as RekognitionClient).inspect(
      await fixtureWebp(800, 1067),
    );
    expect(attributes).toEqual([...FACE_ATTRIBUTES]);
    for (const never of NEVER_FACE_ATTRIBUTES) expect(attributes).not.toContain(never);
    // The scene is asked by name from the closed list, never by a category
    // (Person Description least of all), and nothing is excluded by category
    // because nothing outside the list is asked for.
    expect(settings?.LabelCategoryInclusionFilters).toBeUndefined();
    expect(settings?.LabelCategoryExclusionFilters).toBeUndefined();
    expect(settings?.LabelInclusionFilters).not.toContain("Adult");
    expect(settings?.LabelInclusionFilters).not.toContain("Female");
    expect(settings?.LabelInclusionFilters).not.toContain("Person");
    // What arrived unasked leaves nothing: the signals have the five sights and the listed scene.
    expect(seen.seen).toEqual({
      scene: [
        { name: "Indoors", confidence: 92 },
        { name: "Kitchen", confidence: 90 },
        { name: "Cooking", confidence: 86 },
      ],
      face: {
        smile: { value: true, confidence: 96 },
        eyeglasses: { value: true, confidence: 91 },
        sunglasses: { value: false, confidence: 99 },
        beard: { value: true, confidence: 85 },
        mustache: { value: false, confidence: 97 },
      },
    });
    const description = photoDescriptionOf(seen.seen, 1, 80);
    expect(description).toEqual({
      people: 1,
      setting: "indoors",
      scene: ["kitchen"],
      objects: ["cooking"],
      smile: true,
      glasses: true,
      sunglasses: false,
      facialHair: true,
    });
    // Nothing the check must never say is anywhere in it, by key or by value.
    const text = JSON.stringify(description);
    for (const never of ["Gender", "Female", "AgeRange", "25", "35", "Emotion", "HAPPY", "Adult"]) {
      expect(text).not.toContain(never);
    }
    expect(Object.keys(description).sort()).toEqual(Object.keys(PhotoDescription.shape).sort());
  });
});

describe("the automatic description (#296)", () => {
  it("keeps only the closed list from the scene, whatever the case, and the largest face's five attributes", () => {
    const seen = descriptionSignalsFrom(
      [
        { Name: "lake", Confidence: 90 },
        { Name: "Suggestive", Confidence: 80 },
        { Name: "", Confidence: 80 },
        { Confidence: 80 },
        { Name: "Dog" },
      ],
      [
        {
          Confidence: 90,
          BoundingBox: { Width: 0.1, Height: 0.1 },
          Smile: { Value: true, Confidence: 99 },
        },
        {
          Confidence: 99,
          BoundingBox: { Width: 0.6, Height: 0.6 },
          Smile: { Value: false, Confidence: 80 },
          Beard: { Value: true, Confidence: 88 },
        },
      ],
    );
    expect(seen).toEqual({
      scene: [
        { name: "lake", confidence: 90 },
        { name: "Dog", confidence: 0 },
      ],
      face: {
        smile: { value: false, confidence: 80 },
        eyeglasses: { value: false, confidence: 0 },
        sunglasses: { value: false, confidence: 0 },
        beard: { value: true, confidence: 88 },
        mustache: { value: false, confidence: 0 },
      },
    });
    expect(descriptionSignalsFrom([], [])).toEqual(NOTHING_SEEN);
  });

  it("says a setting, the surest scenes and objects at the line, a few at most, and the face where it is sure", () => {
    expect(photoDescriptionOf(LAKESIDE, 1, 80)).toEqual(LAKESIDE_DESCRIPTION);
    // The line applies to every part: raised, the woods, the dog and the sunglasses stay unsaid; lowered, Woodland joins.
    expect(photoDescriptionOf(LAKESIDE, 1, 94)).toEqual({
      ...LAKESIDE_DESCRIPTION,
      scene: ["lake"],
      objects: [],
      sunglasses: false,
    });
    expect(photoDescriptionOf(LAKESIDE, 2, 60).scene).toEqual(["lake", "forest"]);
    expect(photoDescriptionOf(LAKESIDE, 2, 60).people).toBe(2);
  });

  it("picks the surer of indoors and outdoors, counts a name once, caps the lists, and reads facial hair from a moustache alone", () => {
    const seen: DescriptionSignals = {
      scene: [
        { name: "Indoors", confidence: 85 },
        { name: "Outdoors", confidence: 90 },
        { name: "Beach", confidence: 81 },
        { name: "beach", confidence: 99 },
        { name: "Sea", confidence: 97 },
        { name: "Sunset", confidence: 96 },
        { name: "Harbor", confidence: 95 },
        { name: "Swimming", confidence: 99 },
        { name: "Surfing", confidence: 98 },
        { name: "Boat", confidence: 97 },
        { name: "Dog", confidence: 96 },
        { name: "Coffee", confidence: 95 },
      ],
      face: {
        smile: { value: true, confidence: 79.9 },
        eyeglasses: { value: false, confidence: 0 },
        sunglasses: { value: false, confidence: 0 },
        beard: { value: false, confidence: 99 },
        mustache: { value: true, confidence: 80 },
      },
    };
    expect(photoDescriptionOf(seen, 1, 80)).toEqual({
      people: 1,
      setting: "outdoors",
      scene: ["beach", "sea", "sunset"],
      objects: ["swimming", "surfing", "boat", "dog"],
      smile: false,
      glasses: false,
      sunglasses: false,
      facialHair: true,
    });
  });

  it("describes a check that saw nothing as nobody, nowhere, with nothing", () => {
    expect(photoDescriptionOf(NOTHING_SEEN, 0, 80)).toEqual({
      people: 0,
      setting: null,
      scene: [],
      objects: [],
      smile: false,
      glasses: false,
      sunglasses: false,
      facialHair: false,
    });
  });
});

/** A moderator that answers a scripted inspection, or throws. */
function scripted(answer: Inspection | Error): Moderator & { seen: number[] } {
  const seen: number[] = [];
  return {
    kind: "rekognition",
    seen,
    async inspect(card) {
      seen.push(card.length);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const THRESHOLDS = { photo_moderation_label_threshold: 60, photo_moderation_face_threshold: 90 };

async function appWith(ctx: TestContext, moderator: Moderator) {
  await withMatchingConfig(ctx.client, { max_photos: 3, ...THRESHOLDS });
  const { logger, lines } = await captureLogger();
  const media = testMediaDeps();
  const app = createApp({
    config: testConfig(),
    logger,
    db: ctx.client,
    media: { ...media.deps, moderator },
  });
  return { app, store: media.store, logs: lines, logger };
}

function multipart(bytes: Uint8Array): FormData {
  const form = new FormData();
  form.append(
    "photo",
    new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: "image/jpeg" }),
    "p.jpg",
  );
  return form;
}

describe("moderation of uploads", () => {
  test("An upload is checked and the photo leaves pending with what the check saw recorded", async ({
    ctx,
  }) => {
    const moderator = scripted(inspection("Suggestive 72", "98"));
    const { app } = await appWith(ctx, moderator);
    const me = await signedInAccount(ctx.client);
    const res = await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 900, height: 1200, exif: false })),
    });
    expect(res.status).toBe(201);
    const photo = await res.json();
    expect(photo.state).toBe("queued");
    expect(moderator.seen).toHaveLength(1); // the card variant, once
    const review = await ctx.client.query(
      "SELECT decision, faces, flagged, labels, model_version, decided_by FROM photo_review WHERE photo_id = $1",
      [photo.id],
    );
    expect(review.rows[0]).toEqual({
      decision: "queued",
      faces: 1,
      flagged: ["Suggestive"],
      labels: [{ name: "Suggestive", parentName: "", confidence: 72 }],
      model_version: "7.0",
      decided_by: null,
    });
    const state = await ctx.client.query("SELECT state FROM photo WHERE id = $1", [photo.id]);
    expect(state.rows[0]?.state).toBe("queued");

    // A clean picture with a face is approved without anyone looking.
    const clean = await appWith(ctx, scripted(inspection("none", "99")));
    const ok = await clean.app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 800, height: 800, exif: false })),
    });
    expect((await ok.json()).state).toBe("approved");
  });

  test("A failing check leaves the photo pending and the nightly sweep tries again", async ({
    ctx,
  }) => {
    const failing = scripted(new Error("Rekognition unavailable"));
    const { app, store, logs, logger } = await appWith(ctx, failing);
    const me = await signedInAccount(ctx.client);
    const res = await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 700, height: 900, exif: false })),
    });
    expect(res.status).toBe(201);
    const photo = await res.json();
    expect(photo.state).toBe("pending");
    const reviews = await ctx.client.query("SELECT count(*) AS n FROM photo_review");
    expect(Number(reviews.rows[0]?.n)).toBe(0);
    expect(logs().some((l) => l.msg === "photo moderation failed; the photo stays pending")).toBe(
      true,
    );

    // Ten minutes later the sweep checks it from the stored card variant.
    const later = new Date(Date.now() + RECHECK_AFTER_MS + 1000);
    const working = scripted(inspection("none", "99"));
    const swept = await sweepPendingPhotos({
      db: ctx.client,
      logger,
      now: () => later,
      moderator: working,
      store,
    });
    expect(swept).toEqual({ rechecked: 1, failed: 0 });
    const key =
      (await ctx.client.query<{ key: string }>("SELECT key FROM photo WHERE id = $1", [photo.id]))
        .rows[0]?.key ?? "";
    expect(working.seen[0]).toBe(store.objects.get(objectKey(key, "card"))?.length);
    const state = await ctx.client.query("SELECT state FROM photo WHERE id = $1", [photo.id]);
    expect(state.rows[0]?.state).toBe("approved");
    // Too fresh to be swept a second time, and nothing pending anyway.
    expect(
      await sweepPendingPhotos({
        db: ctx.client,
        logger,
        now: () => new Date(),
        moderator: working,
        store,
      }),
    ).toEqual({ rechecked: 0, failed: 0 });
  });

  test("A check recorded without the photo moving is retried by the sweep, a person's decision is not", async ({
    ctx,
  }) => {
    // The record and the move are one transaction now; a row from before that
    // (or a crash between the two) must not be pending forever.
    const { app, store, logger } = await appWith(ctx, scripted(new Error("down")));
    const me = await signedInAccount(ctx.client);
    const upload = async () => {
      const res = await app.request("/photos", {
        method: "POST",
        headers: me.headers,
        body: multipart(await fixtureJpeg({ width: 700, height: 900, exif: false })),
      });
      return (await res.json()).id as string;
    };
    const halfWritten = await upload();
    const decidedByPerson = await upload();
    await ctx.client.query(
      `INSERT INTO photo_review (photo_id, labels, faces, flagged, checked_at, decision)
       VALUES ($1, '[]'::jsonb, 1, '{}', now(), 'approved')`,
      [halfWritten],
    );
    const identity = await ctx.client.query<{ identity_id: string }>(
      "SELECT identity_id FROM account WHERE id = $1",
      [me.accountId],
    );
    await ctx.client.query(
      `INSERT INTO photo_review (photo_id, labels, faces, flagged, checked_at, decision, decided_by, decided_at)
       VALUES ($1, '[]'::jsonb, 1, '{}', now(), 'rejected', $2, now())`,
      [decidedByPerson, identity.rows[0]?.identity_id],
    );
    const later = new Date(Date.now() + RECHECK_AFTER_MS + 1000);
    const working = scripted(inspection("none", "99"));
    const swept = await sweepPendingPhotos({
      db: ctx.client,
      logger,
      now: () => later,
      moderator: working,
      store,
    });
    expect(swept).toEqual({ rechecked: 1, failed: 0 });
    const states = await ctx.client.query(
      "SELECT id, state FROM photo WHERE id = ANY($1::uuid[])",
      [[halfWritten, decidedByPerson]],
    );
    expect(Object.fromEntries(states.rows.map((r) => [r.id, r.state]))).toEqual({
      [halfWritten]: "approved",
      [decidedByPerson]: "pending",
    });
  });

  test("A photo without a face is not accepted, and its owner is told why without a moderator", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx, scripted(inspection("none", "none")));
    const me = await signedInAccount(ctx.client);
    const res = await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 800, height: 800, exif: false })),
    });
    expect(res.status).toBe(201);
    const photo = await res.json();
    expect(photo).toMatchObject({ state: "rejected", rejectionReason: "no_person" });
    const review = await ctx.client.query(
      "SELECT decision, reason, flagged, faces, decided_by FROM photo_review WHERE photo_id = $1",
      [photo.id],
    );
    expect(review.rows[0]).toEqual({
      decision: "rejected",
      reason: "no_person",
      flagged: ["no_face"],
      faces: 0,
      decided_by: null,
    });
    // The owner's list says why; the queue (queued photos only) never holds it.
    const mine = await app.request("/photos", { headers: me.headers });
    expect((await mine.json()).photos).toEqual([
      expect.objectContaining({
        id: photo.id,
        state: "rejected",
        rejectionReason: "no_person",
      }),
    ]);
    const queued = await ctx.client.query(
      "SELECT count(*)::int AS n FROM photo WHERE state = 'queued'",
    );
    expect(queued.rows[0]?.n).toBe(0);
    expect(logs().find((l) => l.msg === "photo moderated")).toMatchObject({
      decision: "rejected",
      faces: 0,
      flagged: 1,
    });
  });

  test("A photo with several people is not accepted, and its owner is told why without a moderator", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx, scripted(inspection("none", "99, 97")));
    const me = await signedInAccount(ctx.client);
    const res = await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 800, height: 800, exif: false })),
    });
    expect(res.status).toBe(201);
    const photo = await res.json();
    expect(photo).toMatchObject({ state: "rejected", rejectionReason: "several_people" });
    const review = await ctx.client.query(
      "SELECT decision, reason, flagged, faces, decided_by FROM photo_review WHERE photo_id = $1",
      [photo.id],
    );
    expect(review.rows[0]).toEqual({
      decision: "rejected",
      reason: "several_people",
      flagged: ["several_faces"],
      faces: 2,
      decided_by: null,
    });
    // The owner's list says why; the queue (queued photos only) never holds it.
    const mine = await app.request("/photos", { headers: me.headers });
    expect((await mine.json()).photos).toEqual([
      expect.objectContaining({
        id: photo.id,
        state: "rejected",
        rejectionReason: "several_people",
      }),
    ]);
    const queued = await ctx.client.query(
      "SELECT count(*)::int AS n FROM photo WHERE state = 'queued'",
    );
    expect(queued.rows[0]?.n).toBe(0);
    expect(logs().find((l) => l.msg === "photo moderated")).toMatchObject({
      decision: "rejected",
      faces: 2,
      flagged: 1,
    });
  });

  test("No label name reaches a log line", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx, scripted(inspection("Explicit Nudity 97", "99")));
    const me = await signedInAccount(ctx.client);
    await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 600, height: 800, exif: false })),
    });
    const text = JSON.stringify(logs());
    expect(text).not.toContain("Explicit Nudity");
    expect(text).not.toContain("Nudity");
    const line = logs().find((l) => l.msg === "photo moderated");
    expect(line).toMatchObject({
      accountId: me.accountId,
      decision: "rejected",
      labels: 1,
      flagged: 1,
      faces: 1,
      rekognitionCalls: 3,
    });
  });

  test("Neither a label nor its confidence reaches the owner or a log line", async ({ ctx }) => {
    // Names and numbers nothing else in an answer or a log line would carry.
    const probe: Inspection = {
      checked: true,
      labels: [
        { name: "Probe Label Kuutti", parentName: "Probe Parent Kuutti", confidence: 77.7777 },
      ],
      tipLabels: [{ name: "Sunglasses", parentName: "Probe Face Kuutti", confidence: 66.6666 }],
      faceConfidences: [99],
      seen: NOTHING_SEEN,
      modelVersion: "7.0",
      calls: 3,
    };
    const { app, logs } = await appWith(ctx, scripted(probe));
    const me = await signedInAccount(ctx.client);
    const uploaded = await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 600, height: 800, exif: false })),
    });
    expect(uploaded.status).toBe(201);
    const answers = [await uploaded.text()];
    for (const path of ["/photos", "/profile", "/account/export"]) {
      const res = await app.request(path, { headers: me.headers });
      expect(res.status).toBe(200);
      answers.push(await res.text());
    }
    // What the check saw is kept, for the moderator's queue and nobody else.
    const review = await ctx.client.query<{ labels: unknown }>("SELECT labels FROM photo_review");
    expect(JSON.stringify(review.rows)).toContain("Probe Label Kuutti");
    const seen = [...answers, JSON.stringify(logs())].join("\n");
    for (const secret of ["Probe Label", "Probe Parent", "Probe Face", "77.77", "66.66"]) {
      expect(seen).not.toContain(secret);
    }
  });

  test("An approved photo carries its automatic description to the owner's list, the card and the export", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx, scripted(inspection("none", "99", [], LAKESIDE)));
    const me = await signedInAccount(ctx.client);
    const uploaded = await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 900, height: 1200, exif: false })),
    });
    expect(uploaded.status).toBe(201);
    const photo = Photo.parse(await uploaded.json());
    expect(photo.state).toBe("approved");
    expect(photo.description).toEqual(LAKESIDE_DESCRIPTION);
    // Kept with the review row, beside the labels, as the check wrote it.
    const review = await ctx.client.query<{ description: unknown }>(
      "SELECT description FROM photo_review WHERE photo_id = $1",
      [photo.id],
    );
    expect(review.rows[0]?.description).toEqual(LAKESIDE_DESCRIPTION);
    // The owner's list, and the photo as every write answers it.
    const listed = PhotoList.parse(
      await (await app.request("/photos", { headers: me.headers })).json(),
    );
    expect(listed.photos[0]?.description).toEqual(LAKESIDE_DESCRIPTION);
    const captioned = await app.request(`/photos/${photo.id}/caption`, {
      method: "PUT",
      headers: { ...me.headers, "content-type": "application/json" },
      body: JSON.stringify({ caption: "in_my_element" }),
    });
    expect(Photo.parse(await captioned.json())).toMatchObject({
      caption: "in_my_element",
      description: LAKESIDE_DESCRIPTION,
    });
    // The card, as a viewer would get it, from the same rows.
    await ctx.client.query(
      `INSERT INTO profile (account_id, display_name, bio, fields, prompts)
       VALUES ($1, 'Aino', $2, '{}'::jsonb, '[]'::jsonb)`,
      [me.accountId, "A bio long enough for completeness, words and words and more words."],
    );
    const preview = await app.request("/profile/card", { headers: me.headers });
    const card = CardPreviewResponse.parse(await preview.json()).card;
    expect(card?.photos[0]).toMatchObject({ id: photo.id, description: LAKESIDE_DESCRIPTION });
    // The export: the keys, and the words in the request's language.
    const exported = await openExport(
      await app.request("/account/export", { headers: me.headers }),
    );
    expect(exported.document.photos[0]).toMatchObject({
      id: photo.id,
      description: LAKESIDE_DESCRIPTION,
      descriptionText:
        "Automatic description: One person, outdoors, by a lake. Smiling, sunglasses. Hiking, with a dog.",
    });
    const finnish = await openExport(
      await app.request("/account/export", { headers: { ...me.headers, "accept-language": "fi" } }),
    );
    expect(finnish.document.photos[0]?.descriptionText).toBe(
      "Automaattinen kuvaus: Yksi henkilö, ulkona, järven rannalla. Hymyilee, aurinkolasit. Vaeltamassa, koiran kanssa.",
    );
    // A photo no check has reached says nothing, and so does one checked by the queue-all moderator.
    const unchecked = await appWith(ctx, queueAllModerator());
    const pending = await unchecked.app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 800, height: 800, exif: false })),
    });
    expect(Photo.parse(await pending.json()).description).toBeNull();
  });

  test("The automatic description goes with the photo and with the account", async ({ ctx }) => {
    const { app } = await appWith(ctx, scripted(inspection("none", "99", [], LAKESIDE)));
    const me = await signedInAccount(ctx.client);
    const described = async () => {
      const res = await app.request("/photos", {
        method: "POST",
        headers: me.headers,
        body: multipart(await fixtureJpeg({ width: 800, height: 1000, exif: false })),
      });
      return Photo.parse(await res.json());
    };
    const rows = async () =>
      Number(
        (
          await ctx.client.query<{ n: string }>(
            "SELECT count(*) AS n FROM photo_review WHERE description IS NOT NULL",
          )
        ).rows[0]?.n,
      );
    const gone = await described();
    expect(await rows()).toBe(1);
    expect(
      (await app.request(`/photos/${gone.id}`, { method: "DELETE", headers: me.headers })).status,
    ).toBe(204);
    expect(await rows()).toBe(0);
    await described();
    expect(await rows()).toBe(1);
    const deleted = await app.request("/account/delete", {
      method: "POST",
      headers: { ...me.headers, "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(deleted.status).toBe(204);
    expect(await rows()).toBe(0);
  });

  test("Tip signals are recorded with the review and do not queue the photo", async ({ ctx }) => {
    const moderator = scripted(
      inspection("none", "99", [
        { name: "Bathroom", parentName: "", confidence: 77 },
        { name: "Brightness", parentName: "Face", confidence: 20 },
      ]),
    );
    const { app } = await appWith(ctx, moderator);
    const me = await signedInAccount(ctx.client);
    const res = await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 900, height: 1200, exif: false })),
    });
    expect(res.status).toBe(201);
    const photo = await res.json();
    expect(photo.state).toBe("approved");
    const review = await ctx.client.query(
      "SELECT decision, flagged, labels FROM photo_review WHERE photo_id = $1",
      [photo.id],
    );
    expect(review.rows[0]).toEqual({
      decision: "approved",
      flagged: [],
      labels: [
        { name: "Bathroom", parentName: "", confidence: 77 },
        { name: "Brightness", parentName: "Face", confidence: 20 },
      ],
    });
  });

  test("The automatic check never overwrites a person's decision", async ({ ctx }) => {
    const { store, logger } = await appWith(ctx, scripted(inspection("none", "99")));
    const me = await signedInAccount(ctx.client);
    // A photo a person has already rejected, with its review row.
    const photo = await ctx.client.query<{ id: string }>(
      `INSERT INTO photo (account_id, key, blurhash, width, height, state, rejection_reason, position)
       VALUES ($1, 'k1', 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 800, 600, 'rejected', 'nudity', 0) RETURNING id`,
      [me.accountId],
    );
    const id = photo.rows[0]?.id ?? "";
    const staff = await ctx.client.query<{ id: string }>(
      "INSERT INTO identity (hetu_hmac) VALUES ('staff-hmac') RETURNING id",
    );
    await ctx.client.query(
      `INSERT INTO photo_review (photo_id, labels, faces, flagged, decision, decided_by, decided_at, reason)
       VALUES ($1, '[]', 0, '{}', 'rejected', $2, now(), 'nudity')`,
      [id, staff.rows[0]?.id],
    );
    const decided = await moderatePhoto(
      {
        db: ctx.client,
        logger,
        moderator: scripted(inspection("none", "99")),
        now: () => new Date(),
      },
      {
        photoId: id,
        accountId: me.accountId,
        card: await fixtureJpeg({ width: 300, height: 300, exif: false }),
      },
    );
    expect(decided?.decision).toBe("approved"); // what the machine would say
    const after = await ctx.client.query(
      "SELECT p.state, p.rejection_reason, r.decision, r.decided_by FROM photo p JOIN photo_review r ON r.photo_id = p.id WHERE p.id = $1",
      [id],
    );
    expect(after.rows[0]).toMatchObject({
      state: "rejected",
      rejection_reason: "nudity",
      decision: "rejected",
    });
    expect(after.rows[0]?.decided_by).toBe(staff.rows[0]?.id);
    void store;
  });
});

/** A Rekognition client answering each of the three calls with what it is given. */
function answering(answers: {
  moderation?: Record<string, unknown>;
  faces?: Record<string, unknown>;
  scene?: Record<string, unknown>;
}): RekognitionClient {
  return {
    async send(command: unknown) {
      if (command instanceof DetectFacesCommand) return answers.faces ?? {};
      if (command instanceof DetectLabelsCommand) return answers.scene ?? {};
      return answers.moderation ?? {};
    },
  } as unknown as RekognitionClient;
}

describe("what the Rekognition adapter makes of sparse answers", () => {
  it("an answer with nothing in it is a check that saw nothing: no labels, no faces, no model version", async () => {
    const seen = await rekognitionModerator(answering({})).inspect(await fixtureWebp(80, 107));
    expect(seen).toEqual({
      checked: true,
      labels: [],
      tipLabels: [],
      faceConfidences: [],
      seen: NOTHING_SEEN,
      modelVersion: null,
      calls: 3,
    });
    // No face found, so the check rejects it, by the same rule as any other check (#253).
    expect(decideModeration(seen, lines(60, 90))).toEqual({
      decision: "rejected",
      flagged: [NO_FACE],
      faces: 0,
      reason: "no_person",
      appealable: true,
    });
  });

  it("drops a label without a name, reads a missing parent as none and a missing confidence as zero, and keeps fifty at most", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      Name: `Label ${i}`,
      ParentName: "Parent",
      Confidence: 55.555,
    }));
    const seen = await rekognitionModerator(
      answering({
        moderation: {
          ModerationLabels: [
            { Confidence: 99 },
            { Name: "", Confidence: 99 },
            { Name: "Suggestive" },
            ...many,
          ],
          ModerationModelVersion: "7.0",
        },
        faces: { FaceDetails: [{ Confidence: 98 }, {}] },
      }),
    ).inspect(await fixtureWebp(80, 107));
    expect(seen.labels).toHaveLength(50);
    expect(seen.labels[0]).toEqual({ name: "Suggestive", parentName: "", confidence: 0 });
    expect(seen.labels[1]).toEqual({ name: "Label 0", parentName: "Parent", confidence: 55.56 });
    expect(seen.faceConfidences).toEqual([98, 0]);
    expect(seen.modelVersion).toBe("7.0");
  });
});

describe("tip signals from sparse answers", () => {
  it("skips a scene label without a name and reads a missing parent or confidence as none", () => {
    expect(
      tipLabelsFrom([{ Confidence: 90 }, { Name: "", Confidence: 90 }, { Name: "Bathroom" }], []),
    ).toEqual([{ name: "Bathroom", parentName: "", confidence: 0 }]);
  });

  it("a face with no box, no sunglasses worn and no quality gives no face signal", () => {
    expect(
      tipLabelsFrom(
        [],
        [{ Confidence: 99, Sunglasses: { Value: false, Confidence: 99 }, Quality: {} }],
      ),
    ).toEqual([]);
  });

  it("reads the largest face, and sunglasses without a confidence as zero", () => {
    expect(
      tipLabelsFrom(
        [],
        [
          { Confidence: 99, BoundingBox: { Width: 0.2, Height: 0.2 }, Quality: { Brightness: 80 } },
          {
            Confidence: 99,
            BoundingBox: { Width: 0.5, Height: 0.4 },
            Sunglasses: { Value: true },
            Quality: { Sharpness: 0 },
          },
          { Confidence: 99, BoundingBox: { Width: 0.1 } },
        ],
      ),
    ).toEqual([
      { name: "Sunglasses", parentName: "Face", confidence: 0 },
      { name: "TightCrop", parentName: "Face", confidence: 20 },
      { name: "Sharpness", parentName: "Face", confidence: 0 },
    ]);
  });
});

describe("no automatic check (MODERATION=queue)", () => {
  test("every upload goes to a person as not checked, and nothing is approved by itself", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx, queueAllModerator());
    const me = await signedInAccount(ctx.client);
    const res = await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 600, height: 800, exif: false })),
    });
    expect(res.status).toBe(201);
    const photo = await res.json();
    expect(photo.state).toBe("queued");
    const review = await ctx.client.query(
      "SELECT decision, flagged, labels, faces, model_version FROM photo_review WHERE photo_id = $1",
      [photo.id],
    );
    expect(review.rows[0]).toEqual({
      decision: "queued",
      flagged: [NOT_CHECKED],
      labels: [],
      faces: 0,
      model_version: null,
    });
    expect(logs().find((l) => l.msg === "photo moderated")).toMatchObject({
      moderator: "queue",
      decision: "queued",
      rekognitionCalls: 0,
    });
  });
});

describe("the nightly sweep's failures", () => {
  test("a pending photo whose card variant is gone, and one whose check fails again, both stay pending and are counted", async ({
    ctx,
  }) => {
    const { app, store, logs, logger } = await appWith(ctx, scripted(new Error("down")));
    const me = await signedInAccount(ctx.client);
    const ids: string[] = [];
    for (const width of [500, 501]) {
      const res = await app.request("/photos", {
        method: "POST",
        headers: me.headers,
        body: multipart(await fixtureJpeg({ width, height: 700, exif: false })),
      });
      ids.push((await res.json()).id as string);
    }
    // The first loses its card variant; the second keeps it, and the check is still down.
    const key =
      (await ctx.client.query<{ key: string }>("SELECT key FROM photo WHERE id = $1", [ids[0]]))
        .rows[0]?.key ?? "";
    await store.delete([objectKey(key, "card")]);
    const stillDown = scripted(new Error("still down"));
    const swept = await sweepPendingPhotos({
      db: ctx.client,
      logger,
      now: () => new Date(Date.now() + RECHECK_AFTER_MS + 1000),
      moderator: stillDown,
      store,
    });
    expect(swept).toEqual({ rechecked: 0, failed: 2 });
    expect(stillDown.seen).toHaveLength(1);
    expect(
      logs().find((l) => l.msg === "pending photo has no card variant to check"),
    ).toMatchObject({ photoId: ids[0] });
    const states = await ctx.client.query("SELECT state FROM photo WHERE id = ANY($1::uuid[])", [
      ids,
    ]);
    expect(states.rows).toEqual([{ state: "pending" }, { state: "pending" }]);
  });
});

describe("the owner's appeal (#253)", () => {
  const upload = async (app: ReturnType<typeof createApp>, headers: Record<string, string>) => {
    const res = await app.request("/photos", {
      method: "POST",
      headers,
      body: multipart(await fixtureJpeg({ width: 600, height: 800, exif: false })),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; state: string; appealable: boolean };
  };
  const appeal = (app: ReturnType<typeof createApp>, headers: Record<string, string>, id: string) =>
    app.request(`/photos/${id}/appeal`, { method: "POST", headers });
  const codeOf = async (res: Response) =>
    ((await res.json()) as { error: { code: string } }).error.code;

  test("An owner asks a person to look at a photo the check rejected, once", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx, scripted(inspection("none", "none")));
    const me = await signedInAccount(ctx.client);
    const photo = await upload(app, me.headers);
    expect(photo).toMatchObject({ state: "rejected", appealable: true });

    const res = await appeal(app, me.headers, photo.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: photo.id,
      state: "queued",
      rejectionReason: null,
      appealable: false,
    });
    const review = await ctx.client.query(
      "SELECT decision, reason, appealed_at IS NOT NULL AS appealed FROM photo_review WHERE photo_id = $1",
      [photo.id],
    );
    expect(review.rows[0]).toEqual({ decision: "queued", reason: null, appealed: true });
    expect(logs().find((l) => l.msg === "photo appealed")).toMatchObject({
      accountId: me.accountId,
      photoId: photo.id,
    });

    // Once: a second ask is refused, and nothing moves.
    const again = await appeal(app, me.headers, photo.id);
    expect(again.status).toBe(409);
    expect(await codeOf(again)).toBe("photo_not_appealable");
  });

  test("A photo the check was very sure showed nudity offers no appeal", async ({ ctx }) => {
    const { app } = await appWith(ctx, scripted(inspection("Explicit Nudity 97", "99")));
    const me = await signedInAccount(ctx.client);
    const photo = await upload(app, me.headers);
    expect(photo).toMatchObject({ state: "rejected", appealable: false });
    const res = await appeal(app, me.headers, photo.id);
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("photo_not_appealable");
    const state = await ctx.client.query("SELECT state FROM photo WHERE id = $1", [photo.id]);
    expect(state.rows[0]?.state).toBe("rejected");
  });

  test("A person's rejection offers no appeal, and neither does an approved photo", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx, scripted(inspection("none", "99")));
    const me = await signedInAccount(ctx.client);
    const approved = await upload(app, me.headers);
    expect(approved.state).toBe("approved");
    expect(await codeOf(await appeal(app, me.headers, approved.id))).toBe("photo_not_appealable");
    // A moderator's rejection leaves appealable as it was: false.
    await ctx.client.query(
      "UPDATE photo SET state = 'rejected', rejection_reason = 'other' WHERE id = $1",
      [approved.id],
    );
    const res = await appeal(app, me.headers, approved.id);
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("photo_not_appealable");
  });

  test("The appeal answers 401 without a session, 404 for another account's photo, 400 for a bad id", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx, scripted(inspection("none", "none")));
    const owner = await signedInAccount(ctx.client);
    const other = await signedInAccount(ctx.client);
    const photo = await upload(app, owner.headers);
    expect((await app.request(`/photos/${photo.id}/appeal`, { method: "POST" })).status).toBe(401);
    const theirs = await appeal(app, other.headers, photo.id);
    expect(theirs.status).toBe(404);
    expect((await appeal(app, owner.headers, "not-a-uuid")).status).toBe(400);
    // The owner's photo is untouched by the stranger's try.
    const state = await ctx.client.query("SELECT state, appealable FROM photo WHERE id = $1", [
      photo.id,
    ]);
    expect(state.rows[0]).toEqual({ state: "rejected", appealable: true });
  });
});

describe("the closer look's lines (#253)", () => {
  it("lowers every hard group's reject line to the closer look's, and keeps the rest", () => {
    const usual = lines(60, 90);
    const closer = closerLines(
      { ...usual, groups: { ...usual.groups, hate: { review: 50, reject: 70 } } },
      75,
    );
    expect(closer.groups).toEqual({
      nudity: { review: 60, reject: 75 },
      violence: { review: 60, reject: 75 },
      disturbing: { review: 60, reject: 75 },
      // Already lower than the closer look's: it stays.
      hate: { review: 50, reject: 70 },
    });
    expect(closer).toMatchObject({ labelThreshold: 60, faceThreshold: 90, noAppealNudity: 95 });
  });

  it("names the group a sure label rejected for, and none for any other outcome", () => {
    expect(decideModeration(inspection("Weapons 95", "99"), lines(60, 90)).group).toBe("violence");
    expect(decideModeration(inspection("none", "none"), lines(60, 90)).group).toBeUndefined();
    expect(
      decideModeration(inspection("Explicit Nudity 75", "99"), lines(60, 90)).group,
    ).toBeUndefined();
  });
});

describe("notes of the photo check and the closer look (#253)", () => {
  const DAY = 86_400_000;
  const T = new Date("2026-10-01T12:00:00Z");
  const daysFrom = (base: Date, days: number) => new Date(base.getTime() + days * DAY);

  const pendingPhoto = async (ctx: TestContext, accountId: string) => {
    const { rows } = await ctx.client.query<{ id: string }>(
      `INSERT INTO photo (account_id, key, blurhash, width, height, state, position)
       VALUES ($1, $2, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 800, 1067, 'pending',
               (SELECT coalesce(max(position) + 1, 0) FROM photo WHERE account_id = $1)) RETURNING id`,
      [accountId, `k-${Math.random().toString(36).slice(2)}`],
    );
    return rows[0]?.id ?? "";
  };
  const note = (ctx: TestContext, accountId: string, at: Date) =>
    ctx.client.query(
      "INSERT INTO photo_check_note (account_id, kind, at) VALUES ($1, 'nudity', $2)",
      [accountId, at],
    );
  const notesOf = async (ctx: TestContext, accountId: string) =>
    (
      await ctx.client.query<{ kind: string; at: Date; photo_id: string | null }>(
        "SELECT kind, at, photo_id FROM photo_check_note WHERE account_id = $1 ORDER BY at",
        [accountId],
      )
    ).rows;
  /** The check at `now` on a fresh pending photo of the account. */
  const checkAt = async (ctx: TestContext, accountId: string, labels: string, now: Date) => {
    const { logger } = await captureLogger();
    const photoId = await pendingPhoto(ctx, accountId);
    const decided = await moderatePhoto(
      { db: ctx.client, logger, moderator: scripted(inspection(labels, "99")), now: () => now },
      { photoId, accountId, card: await fixtureJpeg({ width: 300, height: 300, exif: false }) },
    );
    return { photoId, decided };
  };

  test("A photo the check is sure of leaves a note of its kind", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx, scripted(inspection("Weapons 93", "99")));
    const me = await signedInAccount(ctx.client);
    const res = await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 600, height: 800, exif: false })),
    });
    expect(res.status).toBe(201);
    const photo = (await res.json()) as { id: string; state: string; rejectionReason: string };
    expect(photo).toMatchObject({ state: "rejected", rejectionReason: "violence" });
    const notes = await notesOf(ctx, me.accountId);
    expect(notes).toEqual([{ kind: "violence", at: expect.any(Date), photo_id: photo.id }]);
    // The note is which kind and when: nothing of the picture, no label, no confidence.
    const columns = await ctx.client.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'photo_check_note' ORDER BY column_name",
    );
    expect(columns.rows.map((r) => r.column_name)).toEqual([
      "account_id",
      "at",
      "id",
      "kind",
      "photo_id",
    ]);
    // Nor does any log line say what kind of photo it was.
    expect(JSON.stringify(logs())).not.toMatch(/violence|weapons/i);
  });

  test("Two notes within thirty days make the check stricter for thirty days", async ({ ctx }) => {
    const me = await signedInAccount(ctx.client);
    const second = daysFrom(T, -9);
    await note(ctx, me.accountId, daysFrom(T, -20));
    await note(ctx, me.accountId, second);

    const under = await checkAt(ctx, me.accountId, "Explicit Nudity 80", T);
    expect(under.decided).toMatchObject({
      decision: "rejected",
      reason: "nudity",
      appealable: true,
    });
    const state = await ctx.client.query("SELECT state, appealable FROM photo WHERE id = $1", [
      under.photoId,
    ]);
    expect(state.rows[0]).toEqual({ state: "rejected", appealable: true });

    // The last moment of the closer look, and the first after it.
    const last = await checkAt(
      ctx,
      me.accountId,
      "Explicit Nudity 80",
      daysFrom(second, 30 - 1 / 86_400),
    );
    expect(last.decided?.decision).toBe("rejected");
    const after = await checkAt(ctx, me.accountId, "Explicit Nudity 80", daysFrom(second, 30));
    expect(after.decided?.decision).toBe("queued");
    // Below the closer look's line, a person is asked as before.
    const low = await checkAt(ctx, me.accountId, "Explicit Nudity 70", T);
    expect(low.decided?.decision).toBe("queued");
  });

  test("What only the closer look rejected leaves no note", async ({ ctx }) => {
    const me = await signedInAccount(ctx.client);
    const second = daysFrom(T, -9);
    await note(ctx, me.accountId, daysFrom(T, -20));
    await note(ctx, me.accountId, second);
    const closer = await checkAt(ctx, me.accountId, "Violence 85", T);
    expect(closer.decided).toMatchObject({ decision: "rejected", reason: "violence" });
    expect(await notesOf(ctx, me.accountId)).toHaveLength(2);
    expect((await closerLookOf(ctx.client, me.accountId, T)).until).toEqual(daysFrom(second, 30));

    // What the usual line is sure of is noted, and moves the end.
    const sure = await checkAt(ctx, me.accountId, "Violence 95", T);
    expect(sure.decided).toMatchObject({ decision: "rejected", group: "violence" });
    expect(await notesOf(ctx, me.accountId)).toHaveLength(3);
    expect((await closerLookOf(ctx.client, me.accountId, T)).until).toEqual(daysFrom(T, 30));
  });

  test("under the closer look the note names the group the owner was told of", async ({ ctx }) => {
    const me = await signedInAccount(ctx.client);
    await note(ctx, me.accountId, daysFrom(T, -20));
    await note(ctx, me.accountId, daysFrom(T, -9));
    // The usual lines are sure of the weapon; the closer look's, of the nudity too, which ranks first.
    const both = await checkAt(ctx, me.accountId, "Weapons 92, Explicit Nudity 80", T);
    expect(both.decided).toMatchObject({ decision: "rejected", reason: "nudity", group: "nudity" });
    const notes = await notesOf(ctx, me.accountId);
    expect(notes.at(-1)).toMatchObject({ kind: "nudity", photo_id: both.photoId });
  });

  test("a check that finds the photo decided by a person already leaves no note", async ({
    ctx,
  }) => {
    const { logger } = await captureLogger();
    const me = await signedInAccount(ctx.client);
    const photoId = await pendingPhoto(ctx, me.accountId);
    await ctx.client.query("UPDATE photo SET state = 'approved' WHERE id = $1", [photoId]);
    const decided = await moderatePhoto(
      {
        db: ctx.client,
        logger,
        moderator: scripted(inspection("Explicit Nudity 97", "99")),
        now: () => T,
      },
      {
        photoId,
        accountId: me.accountId,
        card: await fixtureJpeg({ width: 300, height: 300, exif: false }),
      },
    );
    expect(decided?.decision).toBe("rejected"); // what the machine would say
    expect(await notesOf(ctx, me.accountId)).toEqual([]);
  });

  test("A photo a person approves on appeal takes its note away", async ({ ctx }) => {
    const { app } = await appWith(ctx, scripted(inspection("Weapons 93", "99")));
    const me = await signedInAccount(ctx.client);
    const staff = await staffSession(ctx.client);
    const res = await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 600, height: 800, exif: false })),
    });
    const photo = (await res.json()) as { id: string; appealable: boolean };
    expect(photo.appealable).toBe(true);
    // One more note of another photo: with this one, two would start a closer look.
    await note(ctx, me.accountId, new Date(Date.now() - DAY));
    expect((await closerLookOf(ctx.client, me.accountId, new Date())).until).not.toBeNull();

    expect(
      (await app.request(`/photos/${photo.id}/appeal`, { method: "POST", headers: me.headers }))
        .status,
    ).toBe(200);
    const decided = await app.request(`/admin/photos/${photo.id}/decision`, {
      method: "POST",
      headers: { ...staff.headers, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(decided.status).toBe(200);
    const left = await notesOf(ctx, me.accountId);
    expect(left).toHaveLength(1);
    expect(left[0]?.photo_id).toBeNull();
    expect((await closerLookOf(ctx.client, me.accountId, new Date())).until).toBeNull();
  });

  test("a person who rejects the appealed photo leaves its note as it was", async ({ ctx }) => {
    const { app } = await appWith(ctx, scripted(inspection("Weapons 93", "99")));
    const me = await signedInAccount(ctx.client);
    const staff = await staffSession(ctx.client);
    const res = await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: multipart(await fixtureJpeg({ width: 600, height: 800, exif: false })),
    });
    const photo = (await res.json()) as { id: string };
    await app.request(`/photos/${photo.id}/appeal`, { method: "POST", headers: me.headers });
    const decided = await app.request(`/admin/photos/${photo.id}/decision`, {
      method: "POST",
      headers: { ...staff.headers, "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject", reason: "violence" }),
    });
    expect(decided.status).toBe(200);
    expect(await notesOf(ctx, me.accountId)).toEqual([
      { kind: "violence", at: expect.any(Date), photo_id: photo.id },
    ]);
  });
});
