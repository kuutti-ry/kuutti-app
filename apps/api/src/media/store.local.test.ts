import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createS3Client } from "../lib/s3.ts";
import { testConfig } from "../test/harness.ts";
import { fixtureWebp } from "../test/media.ts";
import { objectKey, s3MediaStore } from "./store.ts";
import { presignedS3Signer, URL_TTL_MS } from "./urls.ts";

// The S3 store and the development signer against the S3 stand-in from docker compose,
// when S3_ENDPOINT is set (CI's compose job, or a developer with the stack
// up); skipped otherwise. Never a mocked store here: the memory store serves
// the route tests, this proves the real client and the presigned GET.
const endpoint = process.env.S3_ENDPOINT;

describe.skipIf(!endpoint)("media store (compose stand-in)", () => {
  const config = testConfig({
    S3_ENDPOINT: endpoint,
    S3_BUCKET: process.env.S3_BUCKET ?? "kuutti-media",
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? "kuutti",
    S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? "kuutti-dev-only",
    S3_FORCE_PATH_STYLE: "true",
  });

  it("puts the variants, reads them back, presigns a GET that fetch can open, and deletes them", async () => {
    const client = createS3Client(config);
    const store = s3MediaStore(client, config.S3_BUCKET);
    const signer = presignedS3Signer(client, config.S3_BUCKET);
    const key = `test-${randomBytes(6).toString("hex")}`;
    const bytes = await fixtureWebp(64, 48);
    try {
      await store.put(objectKey(key, "thumb"), bytes, "image/webp");
      expect(Buffer.from((await store.get(objectKey(key, "thumb"))) ?? [])).toEqual(bytes);
      expect(await store.get(objectKey(key, "card"))).toBeNull();

      const url = await signer.sign(objectKey(key, "thumb"), new Date(Date.now() + URL_TTL_MS));
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/webp");
      expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);

      // Without the signature the object is not public.
      const bare = new URL(url);
      bare.search = "";
      expect((await fetch(bare)).status).toBe(403);
    } finally {
      await store.delete([objectKey(key, "thumb")]);
      expect(await store.get(objectKey(key, "thumb"))).toBeNull();
      client.destroy();
    }
  });

  it("a failure other than a missing object is thrown, never read as a missing object", async () => {
    const client = createS3Client(config);
    try {
      const store = s3MediaStore(client, `no-such-bucket-${randomBytes(4).toString("hex")}`);
      await expect(store.get(objectKey("anything", "thumb"))).rejects.toMatchObject({
        name: "NoSuchBucket",
      });
    } finally {
      client.destroy();
    }
  });

  it("deleting nothing sends no request, so even a missing bucket cannot fail it", async () => {
    const client = createS3Client(config);
    try {
      const store = s3MediaStore(client, `no-such-bucket-${randomBytes(4).toString("hex")}`);
      await expect(store.delete([])).resolves.toBeUndefined();
      // The same store with something to delete does reach the bucket, and fails.
      await expect(store.delete([objectKey("anything", "thumb")])).rejects.toMatchObject({
        name: "NoSuchBucket",
      });
    } finally {
      client.destroy();
    }
  });

  it("a delete that leaves an object behind is a failure naming how many and why", async () => {
    const client = createS3Client(config);
    const store = s3MediaStore(client, config.S3_BUCKET);
    const key = objectKey(`test-${randomBytes(6).toString("hex")}`, "card");
    // S3 refuses a key over 1024 bytes per object, inside a 200 answer.
    const refused = "k".repeat(1100);
    try {
      await store.put(key, await fixtureWebp(16, 16), "image/webp");
      await expect(store.delete([key, refused])).rejects.toThrow(
        "DeleteObjects left 1 of 2 objects (KeyTooLongError)",
      );
      // The rest of the batch was still deleted.
      expect(await store.get(key)).toBeNull();
    } finally {
      await store.delete([key]);
      client.destroy();
    }
  });
});
