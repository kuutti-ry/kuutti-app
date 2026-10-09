import { createPrivateKey } from "node:crypto";
import { availableParallelism } from "node:os";
import { RekognitionClient } from "@aws-sdk/client-rekognition";
import pLimit from "p-limit";
import type { Config } from "../lib/config.ts";
import { createS3Client } from "../lib/s3.ts";
import { type Moderator, queueAllModerator, rekognitionModerator } from "./moderation.ts";
import type { MediaDeps } from "./photos.ts";
import { s3MediaStore } from "./store.ts";
import { cloudFrontSigner, presignedS3Signer } from "./urls.ts";

/**
 * What the boot decided about media, for the log line: `cloudfront` on AWS
 * (the bucket through the instance role, URLs signed with the key from SSM),
 * `presigned` locally (the compose stand-in signs its own GETs), `off` when nothing is
 * configured, in which case the photo routes answer 503.
 */
export type MediaSetup =
  | {
      mode: "cloudfront";
      bucket: string;
      baseUrl: string;
      keyPairId: string;
      concurrency: number;
      moderation: Moderator["kind"];
    }
  | {
      mode: "presigned";
      bucket: string;
      endpoint: string;
      concurrency: number;
      moderation: Moderator["kind"];
    }
  | { mode: "off"; reason: string };

/**
 * The automatic check (#49): Rekognition through the instance role where the
 * configuration says so, otherwise everything goes to a person. A deployed
 * environment without MODERATION=rekognition therefore fills the queue rather
 * than approving anything; it is loud, not unsafe.
 */
function moderatorFor(config: Config): Moderator {
  if (config.MODERATION === "rekognition") {
    return rekognitionModerator(new RekognitionClient({ region: config.S3_REGION }));
  }
  return queueAllModerator();
}

/**
 * Media deps from the validated configuration. Half a CloudFront
 * configuration is a misnamed parameter and throws, like half an OIDC one; a
 * deployed environment never falls back to presigned stand-in URLs, which exist
 * for a developer's machine only (rule 8: nothing on AWS is reachable except
 * through the distribution).
 */
export function createMediaDeps(config: Config): { deps?: MediaDeps; setup: MediaSetup } {
  const concurrency = config.IMAGE_CONCURRENCY ?? Math.max(1, availableParallelism());
  const limit = pLimit(concurrency);
  const cloudfront = [
    config.MEDIA_URL_BASE,
    config.CLOUDFRONT_KEY_PAIR_ID,
    config.CLOUDFRONT_SIGNING_KEY,
  ];
  const configured = cloudfront.filter((v) => v !== undefined).length;
  if (configured > 0 && configured < cloudfront.length) {
    throw new Error(
      "media half configured: MEDIA_URL_BASE, CLOUDFRONT_KEY_PAIR_ID and CLOUDFRONT_SIGNING_KEY go together",
    );
  }
  if (config.MEDIA_URL_BASE && config.CLOUDFRONT_KEY_PAIR_ID && config.CLOUDFRONT_SIGNING_KEY) {
    // ADR-005 §5: a value that is not a private key (the public half by
    // mistake, a truncated PEM) fails the boot here, not the first photo.
    // The error names nothing of the value.
    try {
      createPrivateKey(config.CLOUDFRONT_SIGNING_KEY);
    } catch {
      throw new Error("CLOUDFRONT_SIGNING_KEY is not a private key in PEM");
    }
    const client = createS3Client(config);
    const moderator = moderatorFor(config);
    return {
      deps: {
        store: s3MediaStore(client, config.S3_BUCKET),
        signer: cloudFrontSigner({
          baseUrl: config.MEDIA_URL_BASE,
          keyPairId: config.CLOUDFRONT_KEY_PAIR_ID,
          privateKey: config.CLOUDFRONT_SIGNING_KEY,
        }),
        limit,
        moderator,
      },
      setup: {
        mode: "cloudfront",
        bucket: config.S3_BUCKET,
        baseUrl: config.MEDIA_URL_BASE,
        keyPairId: config.CLOUDFRONT_KEY_PAIR_ID,
        concurrency,
        moderation: moderator.kind,
      },
    };
  }
  if (config.S3_ENDPOINT) {
    if (config.APP_ENV !== "development" && config.APP_ENV !== "test") {
      throw new Error(
        `media: presigned object-store URLs are for development only, not ${config.APP_ENV}; configure CloudFront`,
      );
    }
    const client = createS3Client(config);
    const moderator = moderatorFor(config);
    return {
      deps: {
        store: s3MediaStore(client, config.S3_BUCKET),
        signer: presignedS3Signer(client, config.S3_BUCKET),
        limit,
        moderator,
      },
      setup: {
        mode: "presigned",
        bucket: config.S3_BUCKET,
        endpoint: config.S3_ENDPOINT,
        concurrency,
        moderation: moderator.kind,
      },
    };
  }
  return {
    setup: {
      mode: "off",
      reason: "neither MEDIA_URL_BASE (CloudFront) nor S3_ENDPOINT (the compose stand-in) is set",
    },
  };
}
