import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { PhotoVariant } from "@kuutti/schema";

// Where the variants live. One implementation over S3 (the compose stand-in locally, the
// media bucket through the instance role on AWS, both via lib/s3.ts); tests
// use an in-memory one. Only the pipeline's output ever reaches put(), so the
// store never sees an original (rule 4).

/** One object as the bucket lists it: its key and when it was last written. */
export type StoredObject = { key: string; lastModified: Date };

export type MediaStore = {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Null when the object is missing. */
  get(key: string): Promise<Uint8Array | null>;
  delete(keys: string[]): Promise<void>;
  /**
   * Every object whose key starts with `prefix`, a thousand a page: the night's
   * sweep reads `media/` this way (#636), nothing else lists.
   */
  list(prefix: string): Promise<StoredObject[]>;
};

/** media/<content address>/<variant>.webp: the object path of one variant. */
export function objectKey(contentKey: string, variant: PhotoVariant): string {
  return `media/${contentKey}/${variant}.webp`;
}

export const WEBP = "image/webp";

export function s3MediaStore(client: S3Client, bucket: string): MediaStore {
  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          // Immutable by construction: the address is the content. A year is
          // CloudFront's suggested maximum; the signed URL, not the cache, limits who sees it.
          CacheControl: "public, max-age=31536000, immutable",
        }),
      );
    },
    async get(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return out.Body ? await out.Body.transformToByteArray() : null;
      } catch (error) {
        if ((error as { name?: string }).name === "NoSuchKey") return null;
        throw error;
      }
    },
    async delete(keys) {
      if (keys.length === 0) return;
      // S3 accepts at most 1000 keys per DeleteObjects request. Erasure and
      // report pruning can release more variants than that (TD-7).
      for (let offset = 0; offset < keys.length; offset += 1000) {
        const batch = keys.slice(offset, offset + 1000);
        const out = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        // A 200 response can still list per-object failures, even in quiet
        // mode. Stop on a failed batch; never report a partial delete as success.
        const failed = out.Errors ?? [];
        if (failed.length > 0) {
          const codes = [...new Set(failed.map((e) => e.Code ?? "unknown"))].join(", ");
          throw new Error(
            `DeleteObjects left ${failed.length} of ${batch.length} objects (${codes})`,
          );
        }
      }
    },
    async list(prefix) {
      const objects: StoredObject[] = [];
      let token: string | undefined;
      do {
        const out = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const object of out.Contents ?? []) {
          // S3 and the stand-in name both for every object; one without either is nothing to sweep.
          if (object.Key && object.LastModified) {
            objects.push({ key: object.Key, lastModified: object.LastModified });
          }
        }
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token);
      return objects;
    },
  };
}

/**
 * For tests and the document generator: a Map, nothing else, and the time of
 * each put from `now` for `list`. An object a test sets on the map itself has
 * no time and lists as from the epoch: old enough for any sweep.
 */
export function memoryMediaStore(
  now: () => Date = () => new Date(),
): MediaStore & { objects: Map<string, Uint8Array>; writtenAt: Map<string, Date> } {
  const objects = new Map<string, Uint8Array>();
  const writtenAt = new Map<string, Date>();
  return {
    objects,
    writtenAt,
    async put(key, body) {
      objects.set(key, body);
      writtenAt.set(key, now());
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async delete(keys) {
      for (const key of keys) {
        objects.delete(key);
        writtenAt.delete(key);
      }
    },
    async list(prefix) {
      return [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, lastModified: writtenAt.get(key) ?? new Date(0) }));
    },
  };
}
