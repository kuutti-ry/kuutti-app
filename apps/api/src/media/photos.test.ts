import type { Queryable } from "@kuutti/db";
import { ErrorResponse, Photo, PhotoList } from "@kuutti/schema";
import type { LimitFunction } from "p-limit";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { fixtureJpeg, fixturePng, testMediaDeps } from "../test/media.ts";
import { type MediaStore, memoryMediaStore } from "./store.ts";

// The upload's failure paths (#48, TD-7): whatever fails between storing the
// variants and writing the row, no object stays behind without a row unless
// another row shares it, and a failure of the machinery is never told to the
// person as a fault of their picture. The bucket is a memory store that can
// be told to fail; the database is the test's transaction.

type Options = {
  maxPhotos?: number;
  store?: MediaStore;
  limit?: LimitFunction;
  db?: Queryable;
};

async function appWith(ctx: TestContext, options: Options = {}) {
  await withMatchingConfig(ctx.client, { max_photos: options.maxPhotos ?? 3 });
  const { logger, lines } = await captureLogger();
  const media = testMediaDeps();
  const app = createApp({
    config: testConfig(),
    logger,
    db: options.db ?? ctx.client,
    media: {
      ...media.deps,
      store: options.store ?? media.deps.store,
      limit: options.limit ?? media.deps.limit,
    },
  });
  return { app, logs: lines };
}

type App = Awaited<ReturnType<typeof appWith>>["app"];

function upload(app: App, headers: Record<string, string>, bytes: Uint8Array) {
  const form = new FormData();
  form.append("photo", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), "p.jpg");
  return app.request("/photos", { method: "POST", headers, body: form });
}

const errorCode = async (res: Response) => ErrorResponse.parse(await res.json()).error.code;

/** A memory bucket whose put or delete can be made to fail, the way S3 fails: by rejecting. */
function flakyStore() {
  const inner = memoryMediaStore();
  const fail = { put: null as RegExp | null, delete: false };
  const store: MediaStore = {
    async put(key, body, contentType) {
      if (fail.put?.test(key)) throw new Error("SlowDown: the bucket refused the object");
      await inner.put(key, body, contentType);
    },
    get: (key) => inner.get(key),
    async delete(keys) {
      if (fail.delete) throw new Error("InternalError: the bucket did not delete");
      await inner.delete(keys);
    },
  };
  return { store, objects: inner.objects, fail };
}

async function photoRows(ctx: TestContext, accountId: string) {
  const { rows } = await ctx.client.query<{ key: string }>(
    "SELECT key FROM photo WHERE account_id = $1",
    [accountId],
  );
  return rows;
}

describe("an upload that fails after processing", () => {
  test("a variant the bucket refuses takes the variants already stored with it, and the answer is a generic 500", async ({
    ctx,
  }) => {
    const bucket = flakyStore();
    bucket.fail.put = /\/full\.webp$/;
    const { app, logs } = await appWith(ctx, { store: bucket.store });
    const me = await signedInAccount(ctx.client);
    const res = await upload(app, me.headers, await fixturePng(320, 240));
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe("internal_error");
    expect(bucket.objects.size).toBe(0);
    expect(await photoRows(ctx, me.accountId)).toEqual([]);
    expect(logs().some((l) => l.msg === "photo orphan cleanup failed")).toBe(false);
  });

  test("when the cleanup fails too, it is logged against the account and the upload still fails", async ({
    ctx,
  }) => {
    const bucket = flakyStore();
    bucket.fail.put = /\/card\.webp$/;
    bucket.fail.delete = true;
    const { app, logs } = await appWith(ctx, { store: bucket.store });
    const me = await signedInAccount(ctx.client);
    const res = await upload(app, me.headers, await fixturePng(321, 240));
    expect(res.status).toBe(500);
    const line = logs().find((l) => l.msg === "photo orphan cleanup failed");
    expect(line).toMatchObject({ accountId: me.accountId });
    expect(await photoRows(ctx, me.accountId)).toEqual([]);
  });

  test("a failed upload of a picture another row already holds leaves that row's objects alone", async ({
    ctx,
  }) => {
    const bucket = flakyStore();
    const { app } = await appWith(ctx, { store: bucket.store });
    const owner = await signedInAccount(ctx.client, "owner");
    const other = await signedInAccount(ctx.client, "other");
    const picture = await fixtureJpeg({ width: 640, height: 480, exif: false });
    const kept = Photo.parse(await (await upload(app, owner.headers, picture)).json());
    expect(bucket.objects.size).toBe(3);

    bucket.fail.put = /\/thumb\.webp$/;
    const res = await upload(app, other.headers, picture);
    expect(res.status).toBe(500);
    expect(bucket.objects.size).toBe(3);
    bucket.fail.put = null;
    const served = await app.request(`/photos/${kept.id}/card`, { headers: owner.headers });
    expect(served.status).toBe(200);
    expect(await photoRows(ctx, other.accountId)).toEqual([]);
  });

  test("an upload that loses the race for the last place is refused as photo_limit and leaves no objects", async ({
    ctx,
  }) => {
    // The count before processing passes; while the variants are stored,
    // another upload of the same account takes the last place. The insert's
    // own cap is the one that holds.
    const bucket = flakyStore();
    const me = await signedInAccount(ctx.client);
    let raced = false;
    const racing: MediaStore = {
      ...bucket.store,
      async put(key, body, contentType) {
        if (!raced) {
          raced = true;
          await ctx.client.query(
            `INSERT INTO photo (account_id, key, blurhash, width, height, position)
             VALUES ($1, 'the-other-upload', 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 10, 10, 0)`,
            [me.accountId],
          );
        }
        await bucket.store.put(key, body, contentType);
      },
    };
    const { app } = await appWith(ctx, { maxPhotos: 1, store: racing });
    const res = await upload(app, me.headers, await fixturePng(322, 240));
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("photo_limit");
    expect(bucket.objects.size).toBe(0);
    expect(await photoRows(ctx, me.accountId)).toEqual([{ key: "the-other-upload" }]);
  });

  test("a failure of the processing machinery is a 500, never a refusal of the picture", async ({
    ctx,
  }) => {
    // Only the pipeline's own refusals become 415 or 422; anything else that
    // goes wrong around it is not the person's fault and is not said to be.
    // A limiter that admits the call and then fails it, as a crashed worker would.
    const broken = Object.assign(
      (() => Promise.reject(new Error("worker gone"))) as unknown as LimitFunction,
      { activeCount: 0, pendingCount: 0, concurrency: 2 },
    );
    const { app } = await appWith(ctx, { limit: broken });
    const me = await signedInAccount(ctx.client);
    const res = await upload(app, me.headers, await fixturePng(323, 240));
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe("internal_error");
    expect(await photoRows(ctx, me.accountId)).toEqual([]);
  });

  test("an upload by an account erased while its picture was processed is not stored", async ({
    ctx,
  }) => {
    // The guard passed; the erasure committed before the insert. The insert
    // refuses the tombstone by itself, and the objects go with the refusal.
    const bucket = flakyStore();
    const me = await signedInAccount(ctx.client);
    let erased = false;
    const erasing: MediaStore = {
      ...bucket.store,
      async put(key, body, contentType) {
        if (!erased) {
          erased = true;
          await ctx.client.query(
            "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
            [me.accountId],
          );
        }
        await bucket.store.put(key, body, contentType);
      },
    };
    const { app } = await appWith(ctx, { store: erasing });
    const res = await upload(app, me.headers, await fixturePng(324, 240));
    expect(res.status).toBe(409);
    expect(bucket.objects.size).toBe(0);
    expect(await photoRows(ctx, me.accountId)).toEqual([]);
  });
});

describe("the order of the photos", () => {
  test("an order naming a photo of another account in place of one's own is refused and changes nothing", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    const mine = [
      Photo.parse(await (await upload(app, a.headers, await fixturePng(330, 200))).json()).id,
      Photo.parse(await (await upload(app, a.headers, await fixturePng(331, 200))).json()).id,
    ];
    const theirs = Photo.parse(
      await (await upload(app, b.headers, await fixturePng(332, 200))).json(),
    ).id;
    const res = await app.request("/photos/order", {
      method: "PUT",
      headers: { ...a.headers, "content-type": "application/json" },
      body: JSON.stringify({ order: [theirs, mine[0]] }),
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("photo_order_invalid");
    const list = async (headers: Record<string, string>) =>
      PhotoList.parse(await (await app.request("/photos", { headers })).json()).photos.map((p) => [
        p.id,
        p.position,
      ]);
    expect(await list(a.headers)).toEqual([
      [mine[0], 0],
      [mine[1], 1],
    ]);
    expect(await list(b.headers)).toEqual([[theirs, 0]]);
  });
});

describe("a URL for an account erased meanwhile", () => {
  test("a fetch that outlives the erasure of its account gets no URL and writes no fetch-log row", async ({
    ctx,
  }) => {
    // The guard and the visibility read pass; the erasure commits before the
    // fetch-log insert, which refuses the tombstone by itself (#51).
    const me = await signedInAccount(ctx.client);
    const photo = await ctx.client.query<{ id: string }>(
      `INSERT INTO photo (account_id, key, blurhash, width, height, position)
       VALUES ($1, 'k-erased', 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 10, 10, 0) RETURNING id`,
      [me.accountId],
    );
    const id = photo.rows[0]?.id ?? "";
    let erased = false;
    const db = {
      async query(text: string, values?: unknown[]) {
        const result = await ctx.client.query(text, values);
        if (!erased && text.includes("EXISTS (SELECT 1 FROM card_shown")) {
          erased = true;
          await ctx.client.query(
            "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
            [me.accountId],
          );
        }
        return result;
      },
    } as Queryable;
    const { app, logs } = await appWith(ctx, { db });
    const res = await app.request(`/photos/${id}/thumb`, { headers: me.headers });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
    const access = await ctx.client.query("SELECT count(*) AS n FROM photo_access");
    expect(Number(access.rows[0]?.n)).toBe(0);
    expect(logs().some((l) => l.msg === "photo url issued")).toBe(false);
  });
});
