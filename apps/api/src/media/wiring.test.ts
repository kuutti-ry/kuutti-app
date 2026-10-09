import { describe, expect, it } from "vitest";
import { parseConfig } from "../lib/config.ts";
import { testConfig } from "../test/harness.ts";
import { testSigningKeys } from "../test/media.ts";
import { createMediaDeps } from "./wiring.ts";

// What boot decides about photos from the configuration (ADR-005): CloudFront
// with all three values, stand-in presigning in development only, off otherwise,
// and never half of one.

const keys = testSigningKeys();
const cloudfront = {
  MEDIA_URL_BASE: "https://api.staging.kuutti.app",
  CLOUDFRONT_KEY_PAIR_ID: "K2JCJMDEHXQW5F",
  CLOUDFRONT_SIGNING_KEY: keys.privateKey,
  S3_BUCKET: "kuutti-media-staging-1",
};

describe("media wiring", () => {
  it("signs with CloudFront when the three values are set, and says so without the key", () => {
    const { deps, setup } = createMediaDeps(
      testConfig({ APP_ENV: "staging", NODE_ENV: "production", ...cloudfront }),
    );
    expect(deps).toBeDefined();
    expect(setup).toEqual({
      mode: "cloudfront",
      bucket: "kuutti-media-staging-1",
      baseUrl: "https://api.staging.kuutti.app",
      keyPairId: "K2JCJMDEHXQW5F",
      concurrency: expect.any(Number),
      moderation: "queue",
    });
    expect(JSON.stringify(setup)).not.toContain("PRIVATE KEY");
  });

  it("presigns GETs on the compose stand-in in development only", () => {
    const local = testConfig({ S3_ENDPOINT: "http://127.0.0.1:9000", IMAGE_CONCURRENCY: "2" });
    expect(createMediaDeps(local).setup).toEqual({
      mode: "presigned",
      bucket: "kuutti-media",
      endpoint: "http://127.0.0.1:9000",
      concurrency: 2,
      moderation: "queue",
    });
    expect(() =>
      createMediaDeps(
        testConfig({ APP_ENV: "staging", NODE_ENV: "production", S3_ENDPOINT: "http://x:9000" }),
      ),
    ).toThrow(/development only/);
  });

  it("is off with nothing configured, and refuses half a CloudFront configuration", () => {
    expect(createMediaDeps(testConfig()).setup.mode).toBe("off");
    expect(() =>
      createMediaDeps(
        testConfig({ MEDIA_URL_BASE: "https://api.staging.kuutti.app", S3_BUCKET: "b" }),
      ),
    ).toThrow(/half configured/);
  });

  it("refuses a signing key that is not a private key, at boot and without quoting it", () => {
    const publicHalf =
      "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n";
    let thrown: unknown;
    try {
      createMediaDeps(
        testConfig({
          APP_ENV: "staging",
          NODE_ENV: "production",
          ...cloudfront,
          CLOUDFRONT_SIGNING_KEY: publicHalf,
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/not a private key/);
    expect((thrown as Error).message).not.toContain("PUBLIC KEY");
  });

  it("a pull-request preview has no media even though it reads staging's parameters", () => {
    // What a preview sees after loadConfig merged /kuutti/staging/*: the
    // bucket, the URL base and the signing key. It must not hold or use them.
    const config = parseConfig({
      APP_ENV: "preview",
      PR_NUMBER: "48",
      DB_HOST: "db.internal",
      DB_NAME: "kuutti",
      DB_PREVIEW_USER: "kuutti_preview",
      DB_PREVIEW_PASSWORD: "preview-secret",
      ...cloudfront,
    });
    expect(config.MEDIA_URL_BASE).toBeUndefined();
    expect(config.CLOUDFRONT_KEY_PAIR_ID).toBeUndefined();
    expect(config.CLOUDFRONT_SIGNING_KEY).toBeUndefined();
    const { deps, setup } = createMediaDeps(config);
    expect(deps).toBeUndefined();
    expect(setup.mode).toBe("off");
  });
});

describe("moderation wiring", () => {
  it("queues everything unless MODERATION says rekognition, whose client is built for the region", () => {
    const local = testConfig({ S3_ENDPOINT: "http://127.0.0.1:9000" });
    expect(createMediaDeps(local).deps?.moderator?.kind).toBe("queue");
    const aws = testConfig({
      APP_ENV: "staging",
      NODE_ENV: "production",
      MODERATION: "rekognition",
      ...cloudfront,
    });
    const { deps, setup } = createMediaDeps(aws);
    expect(deps?.moderator?.kind).toBe("rekognition");
    expect(setup).toMatchObject({ moderation: "rekognition" });
  });
});
