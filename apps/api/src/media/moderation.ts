import {
  DetectFacesCommand,
  DetectModerationLabelsCommand,
  type RekognitionClient,
} from "@aws-sdk/client-rekognition";
import { type Queryable, transaction } from "@kuutti/db";
import { type ModerationLabel, PHOTO_VARIANT_SIZES } from "@kuutti/schema";
import sharp from "sharp";
import type { Logger } from "../lib/logger.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import * as repo from "./repo.ts";
import { type MediaStore, objectKey } from "./store.ts";

// Moderation of every uploaded photo before anyone else sees it (#49, TD-8,
// ADR-006). Rekognition sees the card variant only, re-encoded as JPEG for
// the call, from the API, through the instance role; what comes back is a bounded list of labels with confidences
// and a face count, never the image. Three outcomes: approved (nothing
// flagged, a face present), queued (anything flagged, or no face: a person
// decides), rejected (only ever by a person). Thresholds are matching_config
// rows, never constants here.

/** What one look at a photo yields. `checked: false` means no automatic check ran. */
export type Inspection = {
  checked: boolean;
  labels: ModerationLabel[];
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
export const NOT_CHECKED = "not_checked";
export const NO_FACE = "no_face";

export type Decision = { decision: "approved" | "queued"; flagged: string[]; faces: number };

/**
 * The decision, pure (features/media/moderation.feature): unchecked goes to a
 * person; any label at or above the threshold goes to a person, by name; no
 * face at or above its threshold goes to a person as no_face; the rest is
 * approved. Rejection is never automatic.
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

/** Rekognition through the instance role: two calls per photo, the card variant as JPEG, nothing stored there. */
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
      const [moderation, faces] = await Promise.all([
        client.send(
          new DetectModerationLabelsCommand({
            Image: { Bytes: bytes },
            MinConfidence: REKOGNITION_MIN_CONFIDENCE,
          }),
        ),
        client.send(new DetectFacesCommand({ Image: { Bytes: bytes }, Attributes: ["DEFAULT"] })),
      ]);
      const labels: ModerationLabel[] = (moderation.ModerationLabels ?? [])
        .filter((label) => typeof label.Name === "string" && label.Name.length > 0)
        .slice(0, MAX_LABELS)
        .map((label) => ({
          name: (label.Name ?? "").slice(0, 100),
          parentName: (label.ParentName ?? "").slice(0, 100),
          confidence: Math.round((label.Confidence ?? 0) * 100) / 100,
        }));
      return {
        checked: true,
        labels,
        faceConfidences: (faces.FaceDetails ?? []).map((face) => face.Confidence ?? 0),
        modelVersion: moderation.ModerationModelVersion ?? null,
        calls: 2,
      };
    },
  };
}

/**
 * No automatic check: everything goes to a person. What a developer's machine
 * runs (no Rekognition without the instance role), and the fail-closed answer
 * wherever the check is not configured. Never approves anything.
 */
export function queueAllModerator(): Moderator {
  return {
    kind: "queue",
    async inspect() {
      return { checked: false, labels: [], faceConfidences: [], modelVersion: null, calls: 0 };
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
  const at = deps.now();
  // The record and the move are one unit: a photo never ends up pending with
  // a review row that says it was checked (the sweep would skip it forever).
  const moved = await transaction(deps.db, async (tx) => {
    await repo.upsertAutomaticReview(tx, {
      photoId: input.photoId,
      labels: inspection.labels,
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
      labels: inspection.labels.length,
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
