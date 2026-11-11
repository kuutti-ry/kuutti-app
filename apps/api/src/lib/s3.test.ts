import { randomBytes } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { composeS3Config } from "../test/harness.ts";
import { createS3Client } from "./s3.ts";

// Runs against the S3 stand-in from docker compose when S3_ENDPOINT is set (CI's compose job,
// or a developer with the stack up); skipped otherwise. Never a mocked store.
const endpoint = process.env.S3_ENDPOINT;

describe.skipIf(!endpoint)("object storage (compose stand-in)", () => {
  it("puts and gets an object through the path-style client", async () => {
    const config = composeS3Config(endpoint);
    const s3 = createS3Client(config);
    const key = `probe/${randomBytes(6).toString("hex")}.txt`;
    const body = `kuutti probe ${new Date().toISOString()}`;
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: config.S3_BUCKET,
          Key: key,
          Body: body,
          ContentType: "text/plain",
        }),
      );
      const got = await s3.send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
      expect(await got.Body?.transformToString()).toBe(body);
    } finally {
      await s3
        .send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key }))
        .catch(() => undefined);
      s3.destroy();
    }
  });
});
