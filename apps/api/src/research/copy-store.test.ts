import { randomBytes } from "node:crypto";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, describe, expect, it } from "vitest";
import { createS3Client } from "../lib/s3.ts";
import { testConfig } from "../test/harness.ts";
import { COPY_PREFIX, memoryCopyStore, s3CopyStore } from "./copy-store.ts";

// Where the copy's files live (ADR-029 §1): a day's key, a listing from a
// day on, a read, and a put that never replaces a file.

const bytes = (text: string) => new TextEncoder().encode(text);

describe("the in-memory store the tests use", () => {
  it("lists from a day on, reads, and puts only once", async () => {
    const store = memoryCopyStore();
    expect(await store.putNew("2026-10-02", bytes("b"))).toBe(true);
    expect(await store.putNew("2026-09-30", bytes("a"))).toBe(true);
    expect(await store.putNew("2026-10-02", bytes("again"))).toBe(false);
    expect(await store.days("2026-10-01")).toEqual(["2026-10-02"]);
    expect(await store.days("2026-09-30")).toEqual(["2026-09-30", "2026-10-02"]);
    expect(await store.get("2026-10-02")).toEqual(bytes("b"));
    await expect(store.get("2026-10-01")).rejects.toThrow(/no file of 2026-10-01/);
  });
});

// Against the S3 stand-in from docker compose when S3_ENDPOINT is set (CI's
// compose job, or a developer with the stack up), under a root of its own in
// the media bucket, removed afterwards; skipped otherwise. Never a mocked store.
const endpoint = process.env.S3_ENDPOINT;

describe.skipIf(!endpoint)("the bucket (compose stand-in)", () => {
  const config = testConfig({
    S3_ENDPOINT: endpoint,
    S3_BUCKET: process.env.S3_BUCKET ?? "kuutti-media",
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? "kuutti",
    S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? "kuutti-dev-only",
    S3_FORCE_PATH_STYLE: "true",
  });
  const client = createS3Client(config);
  const root = `test-research-${randomBytes(6).toString("hex")}/`;

  afterAll(async () => {
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: config.S3_BUCKET, Prefix: root }),
    );
    const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key as string }));
    if (keys.length > 0) {
      await client.send(
        new DeleteObjectsCommand({ Bucket: config.S3_BUCKET, Delete: { Objects: keys } }),
      );
    }
    client.destroy();
  });

  it("keys a day by year and month, and writes a day's file once", async () => {
    const store = s3CopyStore(client, config.S3_BUCKET, root);
    expect(await store.putNew("2026-09-30", bytes("first"))).toBe(true);
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: config.S3_BUCKET, Prefix: root }),
    );
    expect(listed.Contents?.map((o) => o.Key)).toEqual([`${root}2026/09/2026-09-30.parquet`]);
    expect(await store.putNew("2026-09-30", bytes("second"))).toBe(false);
    expect(new TextDecoder().decode(await store.get("2026-09-30"))).toBe("first");
  });

  it("lists the days from one on, across pages, and nothing of another shape", async () => {
    const store = s3CopyStore(client, config.S3_BUCKET, root, 2);
    for (const day of ["2026-10-01", "2026-10-02", "2026-11-01"]) {
      await store.putNew(day, bytes(day));
    }
    // Under the root but not a day's file, or a day filed under the wrong month.
    for (const key of ["2026/10/notes.txt", "2026/11/2026-10-03.parquet"]) {
      await client.send(
        new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: `${root}${key}`, Body: "x" }),
      );
    }
    expect(await store.days("2026-10-01")).toEqual(["2026-10-01", "2026-10-02", "2026-11-01"]);
    expect(await store.days("2026-10-02")).toEqual(["2026-10-02", "2026-11-01"]);
    expect(await store.days("2026-12-01")).toEqual([]);
    // The stand-in's own media and probes are never the copy's.
    const research = s3CopyStore(client, config.S3_BUCKET, `${root}missing/`);
    expect(await research.days("2026-01-01")).toEqual([]);
    expect(COPY_PREFIX).toBe("research/");
  });

  it("a missing file is an error, and so is a bucket that does not answer", async () => {
    const store = s3CopyStore(client, config.S3_BUCKET, root);
    await expect(store.get("2020-01-01")).rejects.toMatchObject({ name: "NoSuchKey" });
    const unreachable = new S3Client({
      region: config.S3_REGION,
      endpoint: "http://127.0.0.1:9",
      forcePathStyle: true,
      maxAttempts: 1,
      credentials: { accessKeyId: "kuutti", secretAccessKey: "kuutti-dev-only" },
    });
    try {
      const down = s3CopyStore(unreachable, config.S3_BUCKET, root);
      await expect(down.putNew("2026-10-05", bytes("x"))).rejects.toThrow();
    } finally {
      unreachable.destroy();
    }
  });
});
