import {
  DetectFacesCommand,
  DetectLabelsCommand,
  DetectModerationLabelsCommand,
  type FaceDetail,
  type RekognitionClient,
} from "@aws-sdk/client-rekognition";
import { type Queryable, transaction } from "@kuutti/db";
import {
  type ModerationLabel,
  PHOTO_VARIANT_SIZES,
  type PhotoRejectionReason,
} from "@kuutti/schema";
import sharp from "sharp";
import type { Logger } from "../lib/logger.ts";
import { matchingConfigNumbers } from "../lib/matching-config.ts";
import { closerLookOf, recordPhotoCheckNote } from "../safety/index.ts";
import {
  FISH_SPECIES_LABELS,
  GROUP_REASON,
  groupLineKeys,
  groupOf,
  LABEL_GROUPS,
  type LabelGroup,
} from "./label-groups.ts";
import * as repo from "./repo.ts";
import { type MediaStore, objectKey } from "./store.ts";

// Moderation of every uploaded photo before anyone else sees it (#49, TD-8,
// ADR-006). Rekognition sees the card variant only, re-encoded as JPEG for
// the call, from the API, through the instance role; what comes back is a bounded list of labels with confidences
// and a face count, never the image. Three outcomes: approved (one sure face,
// nothing flagged), rejected by the check itself where it is sure (no face at
// all, or several sure faces: the owner is told at once and no moderator is
// asked, #206, #253), queued where it is not (a moderation label beside one
// face, or faces none of them sure: a person decides). Thresholds are matching_config
// rows, never constants here. Labels kept for the tips of #56 are stored with
// the moderation ones; only the moderation ones can send a photo to the queue.

/** What one look at a photo yields. `checked: false` means no automatic check ran. */
export type Inspection = {
  checked: boolean;
  /** Moderation labels only; decideModeration reads these. */
  labels: ModerationLabel[];
  /** Scene and face tip signals (#56); never used for the queue decision. */
  tipLabels: ModerationLabel[];
  /** One confidence per face DetectFaces found, whatever its value. */
  faceConfidences: number[];
  modelVersion: string | null;
  /** How many calls this cost, for the metric. */
  calls: number;
};

export interface Moderator {
  readonly kind: "rekognition" | "queue";
  inspect(card: Uint8Array): Promise<Inspection>;
}

export type Thresholds = {
  /** A label the check does not know goes to a person at or above this confidence. */
  labelThreshold: number;
  /** A face at or above this confidence counts as a person present. */
  faceThreshold: number;
  /** Each hard group's lines (label-groups.ts): a person from `review`, the check's own rejection from `reject`. */
  groups: Record<LabelGroup, { review: number; reject: number }>;
  /** A nudity label at or above this leaves the owner no appeal: no moderator is sent a picture the check is this sure of (#253). */
  noAppealNudity: number;
};

const LABEL_THRESHOLD_KEY = "photo_moderation_label_threshold";
const FACE_THRESHOLD_KEY = "photo_moderation_face_threshold";
const NO_APPEAL_NUDITY_KEY = "photo_moderation_nudity_no_appeal";
/** Labels stored per photo, at most; Rekognition returns a few, never dozens. */
const MAX_LABELS = 50;
/** Ask Rekognition for everything it is at least this sure of, so #56's tips see the low ones too. */
const REKOGNITION_MIN_CONFIDENCE = 30;
/**
 * Scene labels tips care about; DetectLabels is filtered to these, and to the
 * species the fish tip may name (label-groups.ts). Sunglasses come from the
 * face (DetectFaces), not the scene: a pair on the head or in a hand covers
 * no eyes.
 */
const SCENE_TIP_LABELS = [
  "Mirror",
  "Bathroom",
  "Fish",
  "Fishing",
  ...Object.values(FISH_SPECIES_LABELS),
];
/** The face's tip signals, which tipLabelsFrom stores beside the scene's (#56). */
const FACE_TIP_SIGNALS = ["Sunglasses", "TightCrop", "Brightness", "Sharpness"];
const TIP_SIGNALS: ReadonlySet<string> = new Set([...SCENE_TIP_LABELS, ...FACE_TIP_SIGNALS]);

/**
 * A tip signal stored with the moderation labels (#56): advice for the owner,
 * never what a moderator decides on, so the queue leaves it out (#253: a scene
 * label at its noise level, the nine fish among them, is only clutter there).
 */
export const isTipSignal = (name: string): boolean => TIP_SIGNALS.has(name);
export const NOT_CHECKED = "not_checked";
export const NO_FACE = "no_face";
const SEVERAL_FACES = "several_faces";

export type Decision = {
  decision: "approved" | "queued" | "rejected";
  flagged: string[];
  faces: number;
  /** What the owner is told, set when the check itself rejects. */
  reason?: PhotoRejectionReason;
  /** Set when the check itself rejects: whether the owner may ask a person to look. */
  appealable?: boolean;
  /** The hard group the check was sure of, when that is why it rejected. */
  group?: LabelGroup;
};

const roundConfidence = (n: number) => Math.round(n * 100) / 100;

const asLabel = (name: string, parentName: string, confidence: number): ModerationLabel => ({
  name: name.slice(0, 100),
  parentName: parentName.slice(0, 100),
  confidence: roundConfidence(confidence),
});

/**
 * Tip signals from DetectLabels + DetectFaces (#56). Pure, so the tips rule
 * can read the same shapes from photo_review later. Never used by
 * decideModeration.
 */
export function tipLabelsFrom(
  scene: ReadonlyArray<{ Name?: string; Parents?: { Name?: string }[]; Confidence?: number }>,
  faces: ReadonlyArray<FaceDetail>,
): ModerationLabel[] {
  const out: ModerationLabel[] = [];
  for (const label of scene) {
    if (typeof label.Name !== "string" || label.Name.length === 0) continue;
    out.push(asLabel(label.Name, label.Parents?.[0]?.Name ?? "", label.Confidence ?? 0));
  }
  let largest: FaceDetail | undefined;
  let largestArea = 0;
  for (const face of faces) {
    const area = (face.BoundingBox?.Width ?? 0) * (face.BoundingBox?.Height ?? 0);
    if (area >= largestArea) {
      largestArea = area;
      largest = face;
    }
  }
  if (largest) {
    if (largest.Sunglasses?.Value) {
      out.push(asLabel("Sunglasses", "Face", largest.Sunglasses.Confidence ?? 0));
    }
    // Face area as a fraction × 100 when known; matching_config is the tip threshold (#56).
    // A box can reach past the frame (a face closer than the crop): capped at
    // the whole frame, so the value stays within a label's 0 to 100.
    if (largestArea > 0) out.push(asLabel("TightCrop", "Face", Math.min(largestArea, 1) * 100));
    if (largest.Quality?.Brightness != null) {
      out.push(asLabel("Brightness", "Face", largest.Quality.Brightness));
    }
    if (largest.Quality?.Sharpness != null) {
      out.push(asLabel("Sharpness", "Face", largest.Quality.Sharpness));
    }
  }
  return out.slice(0, MAX_LABELS);
}

/** What photo_review keeps: moderation labels first, then tip signals, capped. */
export function storedLabels(inspection: Inspection): ModerationLabel[] {
  return [...inspection.labels, ...inspection.tipLabels].slice(0, MAX_LABELS);
}

/**
 * The decision, pure (features/media/moderation.feature): unchecked goes to a
 * person. What the check is sure of it decides itself and the owner is told,
 * in this order: a label of a hard group at or above that group's reject line
 * (its reason, #253), no face found at all (no_person, #253), more than one
 * face at or above the face threshold (several_people, #206). What it is
 * unsure of goes to a person: a hard label between its group's lines, a label
 * it does not know at or above `labelThreshold`, or faces found but none at
 * the face threshold (no_face). Allowed labels and tip signals never decide.
 */
export function decideModeration(inspection: Inspection, thresholds: Thresholds): Decision {
  const faces = inspection.faceConfidences.filter((c) => c >= thresholds.faceThreshold).length;
  if (!inspection.checked) return { decision: "queued", flagged: [NOT_CHECKED], faces };
  let sure: LabelGroup | undefined;
  const flagged: string[] = [];
  for (const label of inspection.labels) {
    const group = groupOf(label.name);
    if (group === "allowed") continue;
    const lines = group ? thresholds.groups[group] : undefined;
    if (lines && label.confidence >= lines.reject) {
      // The first sure group found names the reason; LABEL_GROUPS ranks a tie.
      if (!sure || LABEL_GROUPS.indexOf(group as LabelGroup) < LABEL_GROUPS.indexOf(sure)) {
        sure = group as LabelGroup;
      }
    }
    const askAt = lines ? lines.review : thresholds.labelThreshold;
    if (label.confidence >= askAt && !flagged.includes(label.name)) flagged.push(label.name);
  }
  // Every rejection of the check may be appealed, but not over a nudity label this sure (#253).
  const appealable = !inspection.labels.some(
    (label) => groupOf(label.name) === "nudity" && label.confidence >= thresholds.noAppealNudity,
  );
  if (sure) {
    return {
      decision: "rejected",
      flagged,
      faces,
      reason: GROUP_REASON[sure],
      appealable,
      group: sure,
    };
  }
  if (inspection.faceConfidences.length === 0) {
    return {
      decision: "rejected",
      flagged: [...flagged, NO_FACE],
      faces,
      reason: "no_person",
      appealable,
    };
  }
  if (faces > 1) {
    return {
      decision: "rejected",
      flagged: [...flagged, SEVERAL_FACES],
      faces,
      reason: "several_people",
      appealable,
    };
  }
  if (faces === 0) flagged.push(NO_FACE);
  return { decision: flagged.length > 0 ? "queued" : "approved", flagged, faces };
}

/** Rekognition through the instance role: three calls per photo, the card variant as JPEG, nothing stored there. */
export function rekognitionModerator(client: RekognitionClient): Moderator {
  return {
    kind: "rekognition",
    async inspect(card) {
      // The stored variants are WebP (ADR-005 §2) and Rekognition reads JPEG
      // and PNG only: the first upload on staging (09/10/2026) came back as
      // InvalidImageFormatException and stayed pending. One re-encode per
      // check, in memory; what is stored and what the queue sees stays WebP.
      const bytes = await sharp(card, {
        // The card is the API's own, PHOTO_VARIANT_SIZES.card at most (pipeline.ts).
        limitInputPixels: PHOTO_VARIANT_SIZES.card.width * PHOTO_VARIANT_SIZES.card.height,
      })
        .jpeg({ quality: 90 })
        .toBuffer();
      const image = { Bytes: bytes };
      const [moderation, faces, scene] = await Promise.all([
        client.send(
          new DetectModerationLabelsCommand({
            Image: image,
            MinConfidence: REKOGNITION_MIN_CONFIDENCE,
          }),
        ),
        // BoundingBox and Quality come with DEFAULT; ask for Sunglasses too.
        // Not ALL: that includes Gender, and we do not store it.
        client.send(
          new DetectFacesCommand({ Image: image, Attributes: ["DEFAULT", "SUNGLASSES"] }),
        ),
        // Advice only (#56): a failed scene call leaves the tips without the
        // scene and never holds the moderation decision; the log line then
        // counts two calls.
        client
          .send(
            new DetectLabelsCommand({
              Image: image,
              MinConfidence: REKOGNITION_MIN_CONFIDENCE,
              Features: ["GENERAL_LABELS"],
              Settings: {
                GeneralLabels: { LabelInclusionFilters: [...SCENE_TIP_LABELS] },
              },
            }),
          )
          .catch(() => null),
      ]);
      const faceDetails = faces.FaceDetails ?? [];
      const labels: ModerationLabel[] = (moderation.ModerationLabels ?? [])
        .flatMap(({ Name, ParentName, Confidence }) =>
          Name ? [asLabel(Name, ParentName ?? "", Confidence ?? 0)] : [],
        )
        .slice(0, MAX_LABELS);
      return {
        checked: true,
        labels,
        tipLabels: tipLabelsFrom(scene?.Labels ?? [], faceDetails),
        faceConfidences: faceDetails.map((face) => face.Confidence ?? 0),
        modelVersion: moderation.ModerationModelVersion ?? null,
        calls: scene ? 3 : 2,
      };
    },
  };
}

/**
 * No automatic check: everything goes to a person. What a developer's machine
 * runs (no Rekognition without the instance role), and the fail-closed answer
 * wherever the check is not configured. Never approves anything. No tip
 * signals either (MODERATION=queue): without labels there are no tips.
 */
export function queueAllModerator(): Moderator {
  return {
    kind: "queue",
    async inspect() {
      return {
        checked: false,
        labels: [],
        tipLabels: [],
        faceConfidences: [],
        modelVersion: null,
        calls: 0,
      };
    },
  };
}

export type ModerationDeps = {
  db: Queryable;
  logger: Logger;
  moderator: Moderator;
  now: () => Date;
};

/** Every line the decision reads, in one statement; a missing row fails loudly (matching-config.ts). */
export async function readThresholds(db: Queryable): Promise<Thresholds> {
  const groupKeys = LABEL_GROUPS.flatMap((group) => Object.values(groupLineKeys(group)));
  const n = await matchingConfigNumbers(db, [
    LABEL_THRESHOLD_KEY,
    FACE_THRESHOLD_KEY,
    NO_APPEAL_NUDITY_KEY,
    ...groupKeys,
  ]);
  const groups = Object.fromEntries(
    LABEL_GROUPS.map((group) => {
      const keys = groupLineKeys(group);
      return [group, { review: n[keys.review], reject: n[keys.reject] }];
    }),
  ) as Thresholds["groups"];
  return {
    labelThreshold: n[LABEL_THRESHOLD_KEY],
    faceThreshold: n[FACE_THRESHOLD_KEY],
    groups,
    noAppealNudity: n[NO_APPEAL_NUDITY_KEY],
  };
}

/**
 * The lines of a closer look (#253): every hard group rejects from `reject`,
 * or from its own line where that is lower already; the review lines and the
 * no-appeal line stay.
 */
export function closerLines(thresholds: Thresholds, reject: number): Thresholds {
  const groups = Object.fromEntries(
    LABEL_GROUPS.map((group) => {
      const lines = thresholds.groups[group];
      return [group, { review: lines.review, reject: Math.min(lines.reject, reject) }];
    }),
  ) as Thresholds["groups"];
  return { ...thresholds, groups };
}

/**
 * Runs the check on one photo and records the outcome: a photo_review row and
 * the photo's state, which moves only from pending (a person's decision is
 * never overwritten by the machine). A failing check leaves the photo pending
 * and logs why; the nightly sweep tries again. A rejection for a hard label
 * the usual lines are sure of leaves a note (safety/photo-check.ts), and an
 * account with enough recent notes is checked with the closer look's lines
 * (#253). The log line carries counts, never a label name nor the closer look
 * (security checklist: nothing about a person's photo beyond the count reaches
 * a line with their account id).
 */
export async function moderatePhoto(
  deps: ModerationDeps,
  input: { photoId: string; accountId: string; card: Uint8Array },
): Promise<Decision | null> {
  const thresholds = await readThresholds(deps.db);
  let inspection: Inspection;
  try {
    inspection = await deps.moderator.inspect(input.card);
  } catch (error) {
    deps.logger.error(
      { accountId: input.accountId, photoId: input.photoId, err: error },
      "photo moderation failed; the photo stays pending",
    );
    return null;
  }
  const at = deps.now();
  const usual = decideModeration(inspection, thresholds);
  const closer = inspection.checked ? await closerLookOf(deps.db, input.accountId, at) : null;
  const decided = closer?.until
    ? decideModeration(inspection, closerLines(thresholds, closer.reject))
    : usual;
  // Only what the usual lines are sure of is noted, so a closer look never
  // prolongs itself on what it alone rejected; under the stricter lines the
  // note names the group the owner was told of.
  const noted = usual.group ? decided.group : undefined;
  const labels = storedLabels(inspection);
  // The record and the move are one unit: a photo never ends up pending with
  // a review row that says it was checked (the sweep would skip it forever).
  const moved = await transaction(deps.db, async (tx) => {
    await repo.upsertAutomaticReview(tx, {
      photoId: input.photoId,
      labels,
      faces: decided.faces,
      flagged: decided.flagged,
      modelVersion: inspection.modelVersion,
      checkedAt: at,
      decision: decided.decision,
      reason: decided.reason ?? null,
    });
    const movedNow = await repo.movePendingPhoto(
      tx,
      input.photoId,
      decided.decision,
      decided.reason ?? null,
      decided.appealable === true,
    );
    if (movedNow && noted) {
      await recordPhotoCheckNote(tx, {
        accountId: input.accountId,
        photoId: input.photoId,
        kind: noted,
        at,
      });
    }
    return movedNow;
  });
  deps.logger.info(
    {
      accountId: input.accountId,
      photoId: input.photoId,
      moderator: deps.moderator.kind,
      decision: decided.decision,
      moved,
      labels: labels.length,
      flagged: decided.flagged.length,
      faces: decided.faces,
      rekognitionCalls: inspection.calls,
    },
    "photo moderated",
  );
  return decided;
}

/** A photo pending this long with no check recorded was missed (a crash, a failed call): retry it. */
export const RECHECK_AFTER_MS = 10 * 60 * 1000;
const SWEEP_BATCH = 50;

/**
 * The nightly retry (rules/api.md jobs): every pending photo the check never
 * recorded gets one more look, from the stored card variant. Nothing expires
 * into visibility: a photo the check cannot reach stays pending.
 */
export async function sweepPendingPhotos(
  deps: ModerationDeps & { store: MediaStore },
): Promise<{ rechecked: number; failed: number }> {
  const olderThan = new Date(deps.now().getTime() - RECHECK_AFTER_MS);
  const pending = await repo.findPendingUnchecked(deps.db, olderThan, SWEEP_BATCH);
  let rechecked = 0;
  let failed = 0;
  for (const photo of pending) {
    const card = await deps.store.get(objectKey(photo.key, "card"));
    if (!card) {
      failed += 1;
      deps.logger.error({ photoId: photo.id }, "pending photo has no card variant to check");
      continue;
    }
    const decided = await moderatePhoto(deps, {
      photoId: photo.id,
      accountId: photo.accountId,
      card,
    });
    if (decided) rechecked += 1;
    else failed += 1;
  }
  return { rechecked, failed };
}
