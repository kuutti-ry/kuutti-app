import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

/**
 * Where the research copy's files live (#194, ADR-029 §1): one per UTC day,
 * `research/YYYY/MM/YYYY-MM-DD.parquet` in the environment's media bucket,
 * through the S3 client of lib/s3.ts. A file is written once and never
 * replaced: the put is conditional on nothing being there (`If-None-Match:
 * *`), and the instance role may put only that way and delete nothing under
 * `research/` (the infra half of #194). Tests use the in-memory store.
 */
export type CopyStore = {
  /** The days that have a file, from `from` on, ascending. */
  days(from: string): Promise<string[]>;
  /** A day's file; a listed file that cannot be read throws. */
  get(day: string): Promise<Uint8Array>;
  /** Writes the day's file unless one exists; false when one did, which then stands. */
  putNew(day: string, body: Uint8Array): Promise<boolean>;
};

export const COPY_PREFIX = "research/";
/** The media type IANA registered for Parquet (2024). */
const PARQUET = "application/vnd.apache.parquet";

/** research/YYYY/MM/YYYY-MM-DD: the month folder is the table's partition, the name survives a flat sync. */
const stem = (root: string, day: string) => `${root}${day.slice(0, 4)}/${day.slice(5, 7)}/${day}`;

export function s3CopyStore(
  client: S3Client,
  bucket: string,
  root = COPY_PREFIX,
  /** Keys per listing page; S3's own maximum unless a test pages through a few. */
  pageSize = 1000,
): CopyStore {
  // The folder and the name must agree: a key of another shape under the root is not a day's file.
  const file = new RegExp(`^${root}(\\d{4})/(\\d{2})/(\\1-\\2-\\d{2})\\.parquet$`);
  return {
    async days(from) {
      const days: string[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: root,
            // Keys sort by day; the stem without its extension sorts just before the day's own file.
            StartAfter: stem(root, from),
            MaxKeys: pageSize,
            ...(token ? { ContinuationToken: token } : {}),
          }),
        );
        for (const object of page.Contents ?? []) {
          const day = file.exec(String(object.Key))?.[3];
          if (day) days.push(day);
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return days;
    },
    async get(day) {
      const out = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: `${stem(root, day)}.parquet` }),
      );
      // A GetObject that answered streams a body; a missing file has thrown NoSuchKey.
      return (out.Body as NonNullable<typeof out.Body>).transformToByteArray();
    },
    async putNew(day, body) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: `${stem(root, day)}.parquet`,
            Body: body,
            ContentType: PARQUET,
            IfNoneMatch: "*",
          }),
        );
        return true;
      } catch (error) {
        // 412: a file is there. A 409 (a conditional write racing ours) and
        // anything else is thrown, and the next night finds whichever file won.
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        if (status === 412) return false;
        throw error;
      }
    },
  };
}

/** For tests: a Map keyed by day, put-if-absent like the bucket. */
export function memoryCopyStore(): CopyStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async days(from) {
      return [...files.keys()].filter((day) => day >= from).sort();
    },
    async get(day) {
      const file = files.get(day);
      if (!file) throw new Error(`research copy: no file of ${day}`);
      return file;
    },
    async putNew(day, body) {
      if (files.has(day)) return false;
      files.set(day, body);
      return true;
    },
  };
}
