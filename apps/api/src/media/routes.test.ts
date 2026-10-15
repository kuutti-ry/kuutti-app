import { ErrorResponse, PHOTO_MAX_BYTES, Photo, PhotoList, PhotoUrlResponse } from "@kuutti/schema";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import {
  fixtureGif,
  fixtureHugeJpegHeader,
  fixtureJpeg,
  fixturePng,
  TEST_KEY_PAIR_ID,
  TEST_MEDIA_BASE,
  testMediaDeps,
} from "../test/media.ts";
import { objectKey } from "./store.ts";

// The photo routes end to end (#48): real Postgres in a rolled-back
// transaction, a memory store standing in for the bucket, a CloudFront signer
// over a test key. Happy path, validation failure, unauthenticated and
// wrong-user for every route (CLAUDE.md Testing), plus the caps.

const MAX_PHOTOS = 3;

async function appWith(
  ctx: TestContext,
  options: { concurrency?: number; media?: false; now?: () => Date } = {},
) {
  await withMatchingConfig(ctx.client, { max_photos: MAX_PHOTOS });
  const { logger, lines } = await captureLogger();
  const media = testMediaDeps({ concurrency: options.concurrency ?? 2 });
  const app = createApp({
    config: testConfig(),
    logger,
    db: ctx.client,
    ...(options.media === false ? {} : { media: media.deps }),
    ...(options.now ? { now: options.now } : {}),
  });
  return { app, store: media.store, logs: lines };
}

function multipart(bytes: Uint8Array, type = "image/jpeg", field = "photo"): FormData {
  const form = new FormData();
  // A copy into a plain ArrayBuffer: Blob refuses a view over a SharedArrayBuffer by type.
  form.append(
    field,
    new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type }),
    "photo.jpg",
  );
  return form;
}

async function upload(
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
  bytes: Uint8Array,
  type = "image/jpeg",
) {
  return app.request("/photos", { method: "POST", headers, body: multipart(bytes, type) });
}

/** Uploads n photos and approves them in the database, as the check or a moderator would. */
async function approvedPhotos(
  ctx: TestContext,
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
  n: number,
) {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const photo = Photo.parse(
      await (await upload(app, headers, await fixturePng(48 + i, 48))).json(),
    );
    await ctx.client.query("UPDATE photo SET state = 'approved' WHERE id = $1", [photo.id]);
    ids.push(photo.id);
  }
  return ids;
}

async function errorCode(res: Response): Promise<string> {
  return ErrorResponse.parse(await res.json()).error.code;
}

describe("photo routes", () => {
  test("an upload is stored as three WebP variants under a content address, no original, and listed as pending", async ({
    ctx,
  }) => {
    const { app, store, logs } = await appWith(ctx);
    const me = await signedInAccount(ctx.client);
    const input = await fixtureJpeg({ width: 1200, height: 1600 });

    const res = await upload(app, me.headers, input);
    expect(res.status).toBe(201);
    const photo = Photo.parse(await res.json());
    expect(photo).toMatchObject({ state: "pending", position: 0, width: 1200, height: 1600 });

    const keys = [...store.objects.keys()];
    expect(keys).toHaveLength(3);
    const contentKey = keys[0]?.split("/")[1] ?? "";
    expect(contentKey).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(keys)).toEqual(
      new Set(["thumb", "card", "full"].map((v) => `media/${contentKey}/${v}.webp`)),
    );
    for (const bytes of store.objects.values()) {
      expect(Buffer.from(bytes.subarray(0, 4)).toString("latin1")).toBe("RIFF"); // WebP, not the JPEG
      expect(Buffer.from(bytes).equals(input)).toBe(false);
    }
    const row = await ctx.client.query(
      "SELECT account_id, key, state, position FROM photo WHERE id = $1",
      [photo.id],
    );
    expect(row.rows[0]).toEqual({
      account_id: me.accountId,
      key: contentKey,
      state: "pending",
      position: 0,
    });

    const list = await app.request("/photos", { headers: me.headers });
    expect(list.status).toBe(200);
    const body = PhotoList.parse(await list.json());
    expect(body.maxPhotos).toBe(MAX_PHOTOS);
    expect(body.photos.map((p) => p.id)).toEqual([photo.id]);
    // The tips ride on the list, by the photos they are about (#287); none for one still in review.
    expect(body.tips).toEqual([]);
    expect(body.fishSpecies).toBeNull();
    // The key is never in a response or a log line.
    expect(JSON.stringify(body)).not.toContain(contentKey);
    expect(JSON.stringify(logs())).not.toContain(contentKey);
  });

  test("a signed URL stops working fifteen minutes after the clock that issued it", async ({
    ctx,
  }) => {
    // A clock far from the wall's: what the URL says follows it, to the second.
    const issued = new Date("2026-03-01T09:30:00.000Z");
    const { app } = await appWith(ctx, { now: () => issued });
    const me = await signedInAccount(ctx.client);
    const photo = Photo.parse(
      await (await upload(app, me.headers, await fixturePng(400, 300))).json(),
    );
    const res = await app.request(`/photos/${photo.id}/card`, { headers: me.headers });
    expect(res.status).toBe(200);
    const body = PhotoUrlResponse.parse(await res.json());
    const until = new Date(issued.getTime() + 15 * 60 * 1000);
    expect(body.expiresAt).toBe(until.toISOString());
    // CloudFront's canned policy: the URL is refused from this second on.
    expect(new URL(body.url).searchParams.get("Expires")).toBe(String(until.getTime() / 1000));
    const access = await ctx.client.query("SELECT at FROM photo_access WHERE photo_id = $1", [
      photo.id,
    ]);
    expect(access.rows).toEqual([{ at: issued }]);
  });

  test("a signed URL is issued for each variant of one's own photo, logged, and written to photo_access", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx);
    const me = await signedInAccount(ctx.client);
    const photo = Photo.parse(
      await (await upload(app, me.headers, await fixturePng(400, 300))).json(),
    );
    const before = Date.now();
    for (const variant of ["thumb", "card", "full"] as const) {
      const res = await app.request(`/photos/${photo.id}/${variant}`, { headers: me.headers });
      expect(res.status).toBe(200);
      const body = PhotoUrlResponse.parse(await res.json());
      expect(body.variant).toBe(variant);
      const url = new URL(body.url);
      expect(url.origin + url.pathname).toMatch(
        new RegExp(`^${TEST_MEDIA_BASE}/media/[0-9a-f]{64}/${variant}\\.webp$`),
      );
      expect(url.searchParams.get("Key-Pair-Id")).toBe(TEST_KEY_PAIR_ID);
      expect(url.searchParams.get("Signature")).toBeTruthy();
      const expires = new Date(body.expiresAt).getTime() - before;
      expect(expires).toBeGreaterThan(14 * 60 * 1000);
      expect(expires).toBeLessThanOrEqual(15 * 60 * 1000 + 5_000);
    }
    const access = await ctx.client.query(
      "SELECT account_id, photo_id, variant FROM photo_access ORDER BY at",
      [],
    );
    expect(access.rows).toEqual([
      { account_id: me.accountId, photo_id: photo.id, variant: "thumb" },
      { account_id: me.accountId, photo_id: photo.id, variant: "card" },
      { account_id: me.accountId, photo_id: photo.id, variant: "full" },
    ]);
    const issued = logs().filter((l) => l.msg === "photo url issued");
    expect(issued).toHaveLength(3);
    expect(issued[0]).toMatchObject({
      accountId: me.accountId,
      photoId: photo.id,
      variant: "thumb",
    });
    expect(issued[0]?.at).toBeDefined();
  });

  test("validation: no photo part, a JSON body, a declared type outside the list, and lying bytes", async ({
    ctx,
  }) => {
    const { app, store } = await appWith(ctx);
    const me = await signedInAccount(ctx.client);

    const empty = new FormData();
    empty.append("note", "hello");
    const noPart = await app.request("/photos", {
      method: "POST",
      headers: me.headers,
      body: empty,
    });
    expect(noPart.status).toBe(400);
    expect(await errorCode(noPart)).toBe("validation_failed");

    const json = await app.request("/photos", {
      method: "POST",
      headers: { ...me.headers, "content-type": "application/json" },
      body: JSON.stringify({ photo: "x" }),
    });
    expect(json.status).toBe(415);
    expect(await errorCode(json)).toBe("unsupported_media_type");

    const gif = await upload(app, me.headers, await fixtureGif(), "image/gif");
    expect(gif.status).toBe(400);
    expect(await errorCode(gif)).toBe("validation_failed");

    // The declared type is not trusted: GIF bytes labelled JPEG are refused by the header check.
    const lying = await upload(app, me.headers, await fixtureGif(), "image/jpeg");
    expect(lying.status).toBe(415);
    expect(await errorCode(lying)).toBe("photo_unsupported");

    const text = await upload(app, me.headers, Buffer.from("not a picture"), "image/png");
    expect(text.status).toBe(415);

    expect(store.objects.size).toBe(0);
    const rows = await ctx.client.query("SELECT count(*) AS n FROM photo");
    expect(Number(rows.rows[0]?.n)).toBe(0);
  });

  test("the caps: 40 megapixels is refused from the header, over 10 MB before any byte is decoded", async ({
    ctx,
  }) => {
    const { app, store } = await appWith(ctx);
    const me = await signedInAccount(ctx.client);

    const huge = await upload(app, me.headers, fixtureHugeJpegHeader());
    expect(huge.status).toBe(422);
    expect(await errorCode(huge)).toBe("photo_too_many_pixels");

    const big = new Uint8Array(PHOTO_MAX_BYTES + 1);
    big.set([0xff, 0xd8, 0xff]);
    const tooLarge = await upload(app, me.headers, big);
    expect(tooLarge.status).toBe(413);
    expect(await errorCode(tooLarge)).toBe("payload_too_large");

    // The app-wide 1 MB cap does not apply to the upload: a 2 MB picture is fine.
    const twoMb = await fixtureJpeg({ width: 1600, height: 1600, exif: false });
    expect(twoMb.length).toBeLessThan(PHOTO_MAX_BYTES);
    const ok = await upload(app, me.headers, twoMb);
    expect(ok.status).toBe(201);
    expect(store.objects.size).toBe(3);
  });

  test("above the concurrency limit the upload answers 503 with Retry-After", async ({ ctx }) => {
    const { app } = await appWith(ctx, { concurrency: 1 });
    const me = await signedInAccount(ctx.client);
    const bytes = await fixtureJpeg({ width: 1000, height: 1000, exif: false });
    const [a, b] = await Promise.all([
      upload(app, me.headers, bytes),
      upload(app, me.headers, bytes),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 503]);
    const busy = a.status === 503 ? a : b;
    expect(busy.headers.get("retry-after")).toBe("5");
    expect(await errorCode(busy)).toBe("media_busy");
  });

  test("max_photos from matching_config caps the account", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const me = await signedInAccount(ctx.client);
    for (let i = 0; i < MAX_PHOTOS; i += 1) {
      const res = await upload(app, me.headers, await fixturePng(300 + i, 300));
      expect(res.status).toBe(201);
    }
    const over = await upload(app, me.headers, await fixturePng(999, 300));
    expect(over.status).toBe(409);
    expect(await errorCode(over)).toBe("photo_limit");
    const list = PhotoList.parse(
      await (await app.request("/photos", { headers: me.headers })).json(),
    );
    expect(list.photos.map((p) => p.position)).toEqual([0, 1, 2]);
  });

  test("the order is the owner's; positions are renumbered; an incomplete order is refused", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const me = await signedInAccount(ctx.client);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(
        Photo.parse(await (await upload(app, me.headers, await fixturePng(320 + i, 200))).json())
          .id,
      );
    }
    const reorder = (order: unknown) =>
      app.request("/photos/order", {
        method: "PUT",
        headers: { ...me.headers, "content-type": "application/json" },
        body: JSON.stringify({ order }),
      });

    const res = await reorder([ids[2], ids[0], ids[1]]);
    expect(res.status).toBe(200);
    const list = PhotoList.parse(await res.json());
    expect(list.photos.map((p) => p.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(list.photos.map((p) => p.position)).toEqual([0, 1, 2]);

    const partial = await reorder([ids[0], ids[1]]);
    expect(partial.status).toBe(400);
    expect(await errorCode(partial)).toBe("photo_order_invalid");
    const duplicate = await reorder([ids[0], ids[0], ids[1]]);
    expect(await errorCode(duplicate)).toBe("photo_order_invalid");
    expect((await reorder(["not-a-uuid"])).status).toBe(400);
    expect((await reorder([])).status).toBe(400);
  });

  test("a caption is a line from the list (#296): set and on the list, cleared by null; not a line, another account's photo and no session are refused", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx);
    const me = await signedInAccount(ctx.client, "a");
    const other = await signedInAccount(ctx.client, "b");
    const photo = Photo.parse(
      await (await upload(app, me.headers, await fixturePng(400, 300))).json(),
    );
    expect(photo.caption).toBeNull();
    const caption = (headers: Record<string, string>, id: string, body: unknown) =>
      app.request(`/photos/${id}/caption`, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const set = await caption(me.headers, photo.id, { caption: "old_favourite" });
    expect(set.status).toBe(200);
    expect(Photo.parse(await set.json())).toMatchObject({ id: photo.id, caption: "old_favourite" });
    const list = PhotoList.parse(
      await (await app.request("/photos", { headers: me.headers })).json(),
    );
    expect(list.photos.map((p) => p.caption)).toEqual(["old_favourite"]);

    const cleared = await caption(me.headers, photo.id, { caption: null });
    expect(cleared.status).toBe(200);
    expect(Photo.parse(await cleared.json()).caption).toBeNull();

    // A key from the list, never the person's words: anything else is a validation failure.
    expect((await caption(me.headers, photo.id, { caption: "my own words" })).status).toBe(400);
    expect((await caption(me.headers, photo.id, { caption: "" })).status).toBe(400);
    expect((await caption(me.headers, photo.id, {})).status).toBe(400);
    expect((await caption(me.headers, photo.id, { caption: "recent", extra: 1 })).status).toBe(400);

    const theirs = await caption(other.headers, photo.id, { caption: "recent" });
    expect(theirs.status).toBe(404);
    expect(await errorCode(theirs)).toBe("not_found");
    const unknown = await caption(me.headers, "00000000-0000-4000-8000-000000000001", {
      caption: "recent",
    });
    expect(unknown.status).toBe(404);
    const noSession = await caption({}, photo.id, { caption: "recent" });
    expect(noSession.status).toBe(401);

    // Nothing of the refused attempts stuck, and the log names the photo, not the line.
    const after = PhotoList.parse(
      await (await app.request("/photos", { headers: me.headers })).json(),
    );
    expect(after.photos.map((p) => p.caption)).toEqual([null]);
    const captioned = logs().filter((l) => l.msg === "photo captioned");
    expect(captioned).toHaveLength(2);
    expect(JSON.stringify(captioned)).not.toContain("old_favourite");
  });

  test("deleting removes the row and closes the gap; the objects go only when no other row shares them", async ({
    ctx,
  }) => {
    const { app, store } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    const shared = await fixtureJpeg({ width: 900, height: 700, exif: false });
    const first = Photo.parse(await (await upload(app, a.headers, shared)).json());
    const second = Photo.parse(
      await (await upload(app, a.headers, await fixturePng(500, 500))).json(),
    );
    const theirs = Photo.parse(await (await upload(app, b.headers, shared)).json());
    expect(store.objects.size).toBe(6); // the shared picture is one set of objects
    const sharedKey = (
      await ctx.client.query<{ key: string }>("SELECT key FROM photo WHERE id = $1", [first.id])
    ).rows[0]?.key;
    expect(
      (await ctx.client.query("SELECT key FROM photo WHERE id = $1", [theirs.id])).rows[0]?.key,
    ).toBe(sharedKey);

    const gone = await app.request(`/photos/${first.id}`, { method: "DELETE", headers: a.headers });
    expect(gone.status).toBe(204);
    expect(store.objects.has(objectKey(sharedKey ?? "", "full"))).toBe(true); // B still has it
    const list = PhotoList.parse(
      await (await app.request("/photos", { headers: a.headers })).json(),
    );
    expect(list.photos).toHaveLength(1);
    expect(list.photos[0]).toMatchObject({ id: second.id, position: 0 });

    expect(
      (await app.request(`/photos/${theirs.id}`, { method: "DELETE", headers: b.headers })).status,
    ).toBe(204);
    expect(store.objects.has(objectKey(sharedKey ?? "", "full"))).toBe(false);
    expect(store.objects.size).toBe(3);

    expect(
      (await app.request(`/photos/${first.id}`, { method: "DELETE", headers: a.headers })).status,
    ).toBe(404);
    expect(
      (await app.request("/photos/not-a-uuid", { method: "DELETE", headers: a.headers })).status,
    ).toBe(400);
  });

  test("wrong user: another account's photo is not listed, served, deleted or reordered", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    const photo = Photo.parse(
      await (await upload(app, a.headers, await fixturePng(400, 400))).json(),
    );

    const list = PhotoList.parse(
      await (await app.request("/photos", { headers: b.headers })).json(),
    );
    expect(list.photos).toEqual([]);
    const url = await app.request(`/photos/${photo.id}/thumb`, { headers: b.headers });
    expect(url.status).toBe(404);
    expect(await errorCode(url)).toBe("not_found");
    expect(
      (await app.request(`/photos/${photo.id}`, { method: "DELETE", headers: b.headers })).status,
    ).toBe(404);
    const order = await app.request("/photos/order", {
      method: "PUT",
      headers: { ...b.headers, "content-type": "application/json" },
      body: JSON.stringify({ order: [photo.id] }),
    });
    expect(order.status).toBe(400);
    expect(await errorCode(order)).toBe("photo_order_invalid");

    // Nothing of B's touched A's photo: no access row, still A's, still at position 0.
    const access = await ctx.client.query(
      "SELECT count(*) AS n FROM photo_access WHERE account_id = $1",
      [b.accountId],
    );
    expect(Number(access.rows[0]?.n)).toBe(0);
    const still = await app.request(`/photos/${photo.id}/thumb`, { headers: a.headers });
    expect(still.status).toBe(200);
  });

  test("unauthenticated: every photo route answers 401 before reading anything", async ({
    ctx,
  }) => {
    const { app, store } = await appWith(ctx);
    const id = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
    const attempts = [
      app.request("/photos"),
      app.request("/photos", { method: "POST", body: multipart(await fixturePng(64, 64)) }),
      app.request(`/photos/${id}`, { method: "DELETE" }),
      app.request("/photos/order", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order: [id] }),
      }),
      app.request(`/photos/${id}/thumb`),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe("unauthenticated");
    }
    expect(store.objects.size).toBe(0);
  });

  test("without object storage the photo routes answer media_unavailable", async ({ ctx }) => {
    const { app } = await appWith(ctx, { media: false });
    const me = await signedInAccount(ctx.client);
    const list = await app.request("/photos", { headers: me.headers });
    expect(list.status).toBe(503);
    expect(await errorCode(list)).toBe("media_unavailable");
    const up = await upload(app, me.headers, await fixturePng(64, 64));
    expect(up.status).toBe(503);
  });
});

/** Every way the guard refuses a caller, with the code the app acts on (re-login, refresh, or nothing). */
async function refusedCallers(ctx: TestContext) {
  const ended = await signedInAccount(ctx.client);
  await ctx.client.query("UPDATE session SET revoked_at = now() WHERE id = $1", [ended.sessionId]);
  const expired = await signedInAccount(ctx.client);
  await ctx.client.query(
    "UPDATE session SET access_expires_at = now() - interval '1 minute' WHERE id = $1",
    [expired.sessionId],
  );
  return [
    ["no token", {}, "unauthenticated"],
    ["a malformed token", { authorization: "Bearer not-a-token" }, "unauthenticated"],
    ["a token nobody issued", { authorization: `Bearer ${"A".repeat(43)}` }, "unauthenticated"],
    ["an ended session", ended.headers, "session_revoked"],
    ["an expired access token", expired.headers, "session_expired"],
  ] as const;
}

describe("photo routes, every branch of the guard and the parameters", () => {
  test("an ended, expired or unknown session is refused on every photo route with its own code", async ({
    ctx,
  }) => {
    const { app, store } = await appWith(ctx);
    const owner = await signedInAccount(ctx.client);
    const photo = Photo.parse(
      await (await upload(app, owner.headers, await fixturePng(90, 90))).json(),
    );
    for (const [what, headers, code] of await refusedCallers(ctx)) {
      const attempts = [
        app.request("/photos", { headers }),
        app.request("/photos", {
          method: "POST",
          headers,
          body: multipart(await fixturePng(91, 91)),
        }),
        app.request(`/photos/${photo.id}`, { method: "DELETE", headers }),
        app.request("/photos/order", {
          method: "PUT",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ order: [photo.id] }),
        }),
        app.request(`/photos/${photo.id}/thumb`, { headers }),
      ];
      for (const res of await Promise.all(attempts)) {
        expect(res.status, what).toBe(401);
        expect(await errorCode(res), what).toBe(code);
      }
    }
    // Nothing of the owner's moved: one photo, its three objects, no fetch row.
    expect(store.objects.size).toBe(3);
    const access = await ctx.client.query("SELECT count(*) AS n FROM photo_access");
    expect(Number(access.rows[0]?.n)).toBe(0);
  });

  test("a variant that does not exist, or an id that is not one, is refused before anything is read", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx);
    const me = await signedInAccount(ctx.client);
    const photo = Photo.parse(
      await (await upload(app, me.headers, await fixturePng(92, 92))).json(),
    );
    for (const path of [
      `/photos/${photo.id}/original`,
      `/photos/${photo.id}/FULL`,
      "/photos/not-a-uuid/thumb",
    ]) {
      const res = await app.request(path, { headers: me.headers });
      expect(res.status, path).toBe(400);
      expect(await errorCode(res), path).toBe("validation_failed");
    }
    const access = await ctx.client.query("SELECT count(*) AS n FROM photo_access");
    expect(Number(access.rows[0]?.n)).toBe(0);
    expect(logs().some((l) => l.msg === "photo url issued")).toBe(false);
  });

  test("a photo id nobody has is refused like another account's photo, and the miss is logged", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx);
    const me = await signedInAccount(ctx.client);
    const id = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
    const res = await app.request(`/photos/${id}/card`, { headers: me.headers });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
    expect(logs().find((l) => l.msg === "photo refused")).toMatchObject({
      accountId: me.accountId,
      photoId: id,
      variant: "card",
      reason: "not_visible",
    });
  });

  test("without object storage every photo route answers media_unavailable and writes nothing", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx, { media: false });
    const me = await signedInAccount(ctx.client);
    const photo = await ctx.client.query<{ id: string }>(
      `INSERT INTO photo (account_id, key, blurhash, width, height, position)
       VALUES ($1, 'k-off', 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 10, 10, 0) RETURNING id`,
      [me.accountId],
    );
    const id = photo.rows[0]?.id ?? "";
    for (const res of [
      await app.request(`/photos/${id}`, { method: "DELETE", headers: me.headers }),
      await app.request("/photos/order", {
        method: "PUT",
        headers: { ...me.headers, "content-type": "application/json" },
        body: JSON.stringify({ order: [id] }),
      }),
      await app.request(`/photos/${id}/thumb`, { headers: me.headers }),
    ]) {
      expect(res.status).toBe(503);
      expect(await errorCode(res)).toBe("media_unavailable");
    }
    const rows = await ctx.client.query("SELECT id FROM photo WHERE account_id = $1", [
      me.accountId,
    ]);
    expect(rows.rows).toEqual([{ id }]);
    const access = await ctx.client.query("SELECT count(*) AS n FROM photo_access");
    expect(Number(access.rows[0]?.n)).toBe(0);
  });

  test("an order that names a photo twice and leaves another out is refused", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const me = await signedInAccount(ctx.client);
    const ids = [
      Photo.parse(await (await upload(app, me.headers, await fixturePng(93, 93))).json()).id,
      Photo.parse(await (await upload(app, me.headers, await fixturePng(94, 94))).json()).id,
    ];
    const res = await app.request("/photos/order", {
      method: "PUT",
      headers: { ...me.headers, "content-type": "application/json" },
      body: JSON.stringify({ order: [ids[1], ids[1]] }),
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("photo_order_invalid");
    const list = PhotoList.parse(
      await (await app.request("/photos", { headers: me.headers })).json(),
    );
    expect(list.photos.map((p) => p.id)).toEqual(ids);
  });

  test("GET /photos answers a label tip from photo_review against matching_config", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const ids = await approvedPhotos(ctx, app, a.headers, 2);
    for (const id of ids) {
      await ctx.client.query(
        `INSERT INTO photo_review (photo_id, labels, faces, flagged, decision)
         VALUES ($1, $2::jsonb, 1, '{}', 'approved')`,
        [id, JSON.stringify([{ name: "Sunglasses", parentName: "Face", confidence: 80 }])],
      );
    }
    const body = PhotoList.parse(
      await (await app.request("/photos", { headers: a.headers })).json(),
    );
    expect(body.tips).toEqual(["sunglasses", "few_photos"]);
  });

  test("GET /photos names the fish of the fish tip, a local one only, and says null otherwise (#253)", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const [main, second] = await approvedPhotos(ctx, app, a.headers, 2);
    const review = (id: string | undefined, labels: unknown[]) =>
      ctx.client.query(
        `INSERT INTO photo_review (photo_id, labels, faces, flagged, decision)
         VALUES ($1, $2::jsonb, 1, '{}', 'approved')`,
        [id, JSON.stringify(labels)],
      );
    const read = async () => (await app.request("/photos", { headers: a.headers })).json();
    // Sent as null, not left out: no fish yet.
    expect((await read()).fishSpecies).toBeNull();
    // What Rekognition said of the probe picture of a pike, and a tuna surer than the pike.
    await review(main, [
      { name: "Fish", parentName: "Animal", confidence: 94 },
      { name: "Tuna", parentName: "Animal", confidence: 90 },
      { name: "Pike", parentName: "Animal", confidence: 76.5 },
      { name: "Cod", parentName: "Animal", confidence: 55.6 },
    ]);
    await review(second, []);
    const body = PhotoList.parse(await read());
    expect(body.tips).toContain("fish");
    expect(body.fishSpecies).toBe("pike");
  });

  test("PUT /photos/order answers the tips of the new main photo (#287)", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const a = await signedInAccount(ctx.client);
    const [main, second] = await approvedPhotos(ctx, app, a.headers, 2);
    const review = (id: string | undefined, labels: unknown[]) =>
      ctx.client.query(
        `INSERT INTO photo_review (photo_id, labels, faces, flagged, decision)
         VALUES ($1, $2::jsonb, 1, '{}', 'approved')`,
        [id, JSON.stringify(labels)],
      );
    await review(main, []);
    // The fish is on the second photo only, which others do not see first.
    await review(second, [
      { name: "Fish", parentName: "Animal", confidence: 94 },
      { name: "Pike", parentName: "Animal", confidence: 76.5 },
    ]);
    const before = PhotoList.parse(
      await (await app.request("/photos", { headers: a.headers })).json(),
    );
    expect(before.tips).not.toContain("fish");
    expect(before.fishSpecies).toBeNull();
    const reorder = async (order: (string | undefined)[]) => {
      const res = await app.request("/photos/order", {
        method: "PUT",
        headers: { ...a.headers, "content-type": "application/json" },
        body: JSON.stringify({ order }),
      });
      expect(res.status).toBe(200);
      return PhotoList.parse(await res.json());
    };
    // The answer is read after the move, so the card speaks of the new main photo at once.
    const fishFirst = await reorder([second, main]);
    expect(fishFirst.photos.map((p) => p.id)).toEqual([second, main]);
    expect(fishFirst.tips).toContain("fish");
    expect(fishFirst.fishSpecies).toBe("pike");
    const back = await reorder([main, second]);
    expect(back.photos.map((p) => p.id)).toEqual([main, second]);
    expect(back.tips).not.toContain("fish");
    expect(back.fishSpecies).toBeNull();
  });
});
