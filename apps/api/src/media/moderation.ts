import {
  DetectFacesCommand,
  DetectLabelsCommand,
  DetectModerationLabelsCommand,
  type FaceDetail,
  type RekognitionClient,
} from "@aws-sdk/client-rekognition";
import { type Queryable, transaction } from "@kuutti/db";
import type { ModerationLabel } from "@kuutti/schema";
import type { Logger } from "../lib/logger.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import * as repo from "./repo.ts";
import { type MediaStore, objectKey } from "./store.ts";

// Moderation of every uploaded photo before anyone else sees it (#49, TD-8,
// ADR-006). Rekognition sees the card variant only, from the API, through the
// instance role; what comes back is a bounded list of labels with confidences
// and a face count, never the image. Three outcomes: approved (nothing
// flagged, a face present), queued (anything flagged, or no face: a person
// decides), rejected (only ever by a person). Thresholds are matching_config
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
  /** A label at or above this confidence flags the photo. */
  labelThreshold: number;
  /** A face at or above this confidence counts as a person present. */
  faceThreshold: number;
};

export const LABEL_THRESHOLD_KEY = "photo_moderation_label_threshold";
export const FACE_THRESHOLD_KEY = "photo_moderation_face_threshold";
/** Labels stored per photo, at most; Rekognition returns a few, never dozens. */
export const MAX_LABELS = 50;
/** Ask Rekognition for everything it is at least this sure of, so #56's tips see the low ones too. */
const REKOGNITION_MIN_CONFIDENCE = 30;
/** Scene labels tips care about; DetectLabels is filtered to these. */
const SCENE_TIP_LABELS = ["Mirror", "Bathroom", "Sunglasses"] as const;
/** Face fills this much of the frame → TightCrop tip signal. */
const TIGHT_CROP_AREA = 0.4;
export const NOT_CHECKED = "not_checked";
export const NO_FACE = "no_face";

export type Decision = { decision: "approved" | "queued"; flagged: string[]; faces: number };

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
    if (largestArea >= TIGHT_CROP_AREA) {
      out.push(asLabel("TightCrop", "Face", largestArea * 100));
    }
    if (largest.Quality?.Brightness != null) {
      out.push(asLabel("Brightness", "Face", largest.Quality.Brightness));
    }
    if (largest.Quality?.Sharpness != null) {
      out.push(asLabel("Sharpness", "Face", largest.Quality.Sharpness));
    }
  }
  if (faces.length > 1) out.push(asLabel("Group", "Face", 100));
  return out.slice(0, MAX_LABELS);
}

/** What photo_review keeps: moderation labels first, then tip signals, capped. */
export function storedLabels(inspection: Inspection): ModerationLabel[] {
  return [...inspection.labels, ...inspection.tipLabels].slice(0, MAX_LABELS);
}

/**
 * The decision, pure (features/media/moderation.feature): unchecked goes to a
 * person; any moderation label at or above the threshold goes to a person, by
 * name; no face at or above its threshold goes to a person as no_face; the
 * rest is approved. Tip signals are ignored. Rejection is never automatic.
 */
export function decideModeration(inspection: Inspection, thresholds: Thresholds): Decision {
  const faces = inspection.faceConfidences.filter((c) => c >= thresholds.faceThreshold).length;
  if (!inspection.checked) return { decision: "queued", flagged: [NOT_CHECKED], faces };
  const flagged = [
    ...new Set(
      inspection.labels
        .filter((label) => label.confidence >= thresholds.labelThreshold)
        .map((label) => label.name),
    ),
  ];
  if (faces === 0) flagged.push(NO_FACE);
  return { decision: flagged.length > 0 ? "queued" : "approved", flagged, faces };
}

/** Rekognition through the instance role: three calls per photo, the card variant's bytes, nothing stored there. */
export function rekognitionModerator(client: RekognitionClient): Moderator {
  return {
    kind: "rekognition",
    async inspect(card) {
      const image = { Bytes: card };
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
        client.send(
          new DetectLabelsCommand({
            Image: image,
            MinConfidence: REKOGNITION_MIN_CONFIDENCE,
            Features: ["GENERAL_LABELS"],
            Settings: {
              GeneralLabels: { LabelInclusionFilters: [...SCENE_TIP_LABELS] },
            },
          }),
        ),
      ]);
      const faceDetails = faces.FaceDetails ?? [];
      const labels: ModerationLabel[] = (moderation.ModerationLabels ?? [])
        .filter((label) => typeof label.Name === "string" && label.Name.length > 0)
        .slice(0, MAX_LABELS)
        .map((label) => asLabel(label.Name ?? "", label.ParentName ?? "", label.Confidence ?? 0));
      return {
        checked: true,
        labels,
        tipLabels: tipLabelsFrom(scene.Labels ?? [], faceDetails),
        faceConfidences: faceDetails.map((face) => face.Confidence ?? 0),
        modelVersion: moderation.ModerationModelVersion ?? null,
        calls: 3,
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

/**
 * Runs the check on one photo and records the outcome: a photo_review row and
 * the photo's state, which moves only from pending (a person's decision is
 * never overwritten by the machine). A failing check leaves the photo pending
 * and logs why; the nightly sweep tries again. The log line carries counts,
 * never a label name (security checklist: nothing about a person's photo
 * beyond the count reaches a line with their account id).
 */
export async function moderatePhoto(
  deps: ModerationDeps,
  input: { photoId: string; accountId: string; card: Uint8Array },
): Promise<Decision | null> {
  const thresholds: Thresholds = {
    labelThreshold: await matchingConfigNumber(deps.db, LABEL_THRESHOLD_KEY),
    faceThreshold: await matchingConfigNumber(deps.db, FACE_THRESHOLD_KEY),
  };
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
  const decided = decideModeration(inspection, thresholds);
  const labels = storedLabels(inspection);
  const at = deps.now();
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
    });
    return repo.movePendingPhoto(tx, input.photoId, decided.decision);
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
