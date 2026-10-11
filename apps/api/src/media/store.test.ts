import { DeleteObjectsCommand, GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { memoryMediaStore, objectKey, s3MediaStore } from "./store.ts";

// Answers of S3 that the compose stand-in never gives but the API documents
// (store.local.test.ts runs the real client against the stand-in): a
// GetObject with no body, and per-object failures without a code. A client
// that answers each command with what it is given, and records what it sent.

function answering(answer: unknown) {
  const sent: unknown[] = [];
  const client = {
    async send(command: unknown) {
      sent.push(command);
      return answer;
    },
  } as unknown as S3Client;
  return { client, sent };
}

describe("the S3 store on answers the stand-in does not give", () => {
  it("a GetObject answer without a body reads as no object", async () => {
    const { client, sent } = answering({});
    expect(await s3MediaStore(client, "bucket").get(objectKey("k", "thumb"))).toBeNull();
    expect(sent[0]).toBeInstanceOf(GetObjectCommand);
  });

  it("names every distinct failure code once, and a failure without a code as unknown", async () => {
    const { client, sent } = answering({
      Errors: [
        { Key: "a", Code: "AccessDenied" },
        { Key: "b", Code: "AccessDenied" },
        { Key: "c" },
      ],
    });
    await expect(s3MediaStore(client, "bucket").delete(["a", "b", "c", "d"])).rejects.toThrow(
      "DeleteObjects left 3 of 4 objects (AccessDenied, unknown)",
    );
    const command = sent[0] as DeleteObjectsCommand;
    expect(command).toBeInstanceOf(DeleteObjectsCommand);
    expect(command.input).toEqual({
      Bucket: "bucket",
      Delete: { Objects: [{ Key: "a" }, { Key: "b" }, { Key: "c" }, { Key: "d" }], Quiet: true },
    });
  });
});

describe("the memory store", () => {
  it("keeps what is put, answers null for what is not there, and deletes what it is told", async () => {
    const store = memoryMediaStore();
    const key = objectKey("abc", "card");
    expect(key).toBe("media/abc/card.webp");
    await store.put(key, new Uint8Array([1, 2]), "image/webp");
    expect(await store.get(key)).toEqual(new Uint8Array([1, 2]));
    expect(await store.get(objectKey("abc", "full"))).toBeNull();
    await store.delete([key, objectKey("never", "thumb")]);
    expect(store.objects.size).toBe(0);
  });
});
