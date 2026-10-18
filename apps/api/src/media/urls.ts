import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl as signCloudFrontUrl } from "@aws-sdk/cloudfront-signer";
import { getSignedUrl as presignS3Url } from "@aws-sdk/s3-request-presigner";

// Signed URL issuance, the fourth of the four security surfaces (security
// checklist). A URL names one object for fifteen minutes and nothing else; the
// route that hands it out is behind the session guard, is rate limited, and
// writes a photo_access row per issuance. A photo sent in a conversation
// (#350, ADR-031 §10) is signed to the next five-minute mark plus fifteen
// minutes, and logged once per viewer, photo and variant in that window,
// two reads at the same instant aside. On AWS the URL is a CloudFront signed
// URL (TD-8): the distribution refuses the object without a valid signature
// from the key pair whose private half lives in SSM and is read at boot.
// Locally the stand-in is a presigned GET on the compose S3 stand-in, refused outside development
// by the boot wiring in index.ts.

export const URL_TTL_MS = 15 * 60 * 1000;

export type UrlSigner = {
  /** A URL for the object at `objectKey`, valid until `expiresAt`. */
  sign(objectKey: string, expiresAt: Date): Promise<string>;
};

export type CloudFrontSignerOptions = {
  /** https://<distribution host>, without a path; the object key is appended. */
  baseUrl: string;
  /** The id of the CloudFront public key resource (the pair's public half). */
  keyPairId: string;
  /** The private half, PEM, from /kuutti/<env>/cloudfront-signing-key. */
  privateKey: string;
};

export function cloudFrontSigner(options: CloudFrontSignerOptions): UrlSigner {
  const base = options.baseUrl.replace(/\/$/, "");
  return {
    async sign(objectKey, expiresAt) {
      return signCloudFrontUrl({
        url: `${base}/${objectKey}`,
        keyPairId: options.keyPairId,
        privateKey: options.privateKey,
        dateLessThan: expiresAt,
        algorithm: "SHA256",
      });
    },
  };
}

/** Development only: the compose stand-in presigns its own GETs, which is what the phone or the web preview fetches. */
export function presignedS3Signer(
  client: S3Client,
  bucket: string,
  now: () => Date = () => new Date(),
): UrlSigner {
  return {
    async sign(objectKey, expiresAt) {
      const expiresIn = Math.max(1, Math.floor((expiresAt.getTime() - now().getTime()) / 1000));
      return presignS3Url(client, new GetObjectCommand({ Bucket: bucket, Key: objectKey }), {
        expiresIn,
      });
    },
  };
}
