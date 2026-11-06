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
  it.each([0, 1000, 1001, 2501])(
    "deletes %i keys in complete batches of at most 1000",
    async (count) => {
      const { client, sent } = answering({});
      const keys = Array.from({ length: count }, (_, i) => `dummy-${i}`);
      await s3MediaStore(client, "bucket").delete(keys);
      const commands = sent as DeleteObjectsCommand[];
      expect(commands.map((command) => command.input.Delete?.Objects?.length)).toEqual(
        Array.from({ length: Math.ceil(count / 1000) }, (_, i) => Math.min(1000, count - i * 1000)),
      );
      expect(
        commands.flatMap(
          (command) => command.input.Delete?.Objects?.map((object) => object.Key) ?? [],
        ),
      ).toEqual(keys);
      expect(
        commands.every(
          (command) => command.input.Bucket === "bucket" && command.input.Delete?.Quiet === true,
        ),
      ).toBe(true);
    },
  );

  it.each(["response", "transport"] as const)(
    "a later batch's %s failure rejects the whole delete and stops later requests",
    async (kind) => {
      const failure = new Error("dummy storage failure");
      const sent: DeleteObjectsCommand[] = [];
      const client = {
        async send(command: DeleteObjectsCommand) {
          sent.push(command);
          if (sent.length === 2) {
            if (kind === "transport") throw failure;
            return { Errors: [{ Key: "dummy-1000", Code: "AccessDenied" }] };
          }
          return {};
        },
      } as unknown as S3Client;
      const deletion = s3MediaStore(client, "bucket").delete(
        Array.from({ length: 2501 }, (_, i) => `dummy-${i}`),
      );
      if (kind === "transport") await expect(deletion).rejects.toBe(failure);
      else
        await expect(deletion).rejects.toThrow(
          "DeleteObjects left 1 of 1000 objects (AccessDenied)",
        );
      expect(sent).toHaveLength(2);
    },
  );

  it("waits for each delete batch before sending the next", async () => {
    let finishFirst = () => {};
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const sent: DeleteObjectsCommand[] = [];
    const client = {
      async send(command: DeleteObjectsCommand) {
        sent.push(command);
        if (sent.length === 1) await first;
        return {};
      },
    } as unknown as S3Client;
    const deletion = s3MediaStore(client, "bucket").delete(
      Array.from({ length: 1001 }, (_, i) => `dummy-${i}`),
    );
    expect(sent).toHaveLength(1);
    finishFirst();
    await deletion;
    expect(sent).toHaveLength(2);
  });

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
