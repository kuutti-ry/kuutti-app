import { PHOTO_VARIANTS } from "@kuutti/schema";
import { describe, expect } from "vitest";
import { signedInAccount, staffSession, withMatchingConfig } from "../test/account.ts";
import { captureLogger, type TestContext, test } from "../test/harness.ts";
import { testMediaDeps } from "../test/media.ts";
import { deleteOrphanedObjects, erasePhotosOfAccount, exportPhotos } from "./erasure.ts";
import type { PhotoServiceDeps } from "./photos.ts";
import { insertPhoto, insertPhotoAccess } from "./repo.ts";
import { type MediaStore, objectKey } from "./store.ts";

// The media half of erasure and export (#51, TD-7): the rows inside the
// caller's transaction, the objects after it and only when no row still
// holds them, and the export of what the person's photos are and who saw
// them. Real Postgres, a memory bucket.

describe("media inserts after erasure", () => {
  test("the photo and fetch-log inserts refuse an erased account", async ({ ctx }) => {
    await withMatchingConfig(ctx.client, { max_photos: 6 });
    const a = await signedInAccount(ctx.client);
    await ctx.client.query(
      "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
      [a.accountId],
    );
    expect(
      await insertPhoto(ctx.client, {
        accountId: a.accountId,
        key: "k-late",
        blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
        width: 1,
        height: 1,
        maxPhotos: 6,
      }),
    ).toBeNull();
    const access = await insertPhotoAccess(ctx.client, {
      accountId: a.accountId,
      photoId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
      variant: "thumb",
      at: new Date(),
      since: new Date(Date.now() - 3_600_000),
      limit: 100,
    });
    expect(access).toMatchObject({ live: false, recorded: false });
    for (const table of ["photo", "photo_access"]) {
      const { rows } = await ctx.client.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE account_id = $1`,
        [a.accountId],
      );
      expect(Number(rows[0]?.n), table).toBe(0);
    }
  });
});

const BLURHASH = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";

async function photoOf(
  ctx: TestContext,
  accountId: string,
  key: string,
  state: "pending" | "queued" | "approved" | "rejected" = "approved",
  position = 0,
): Promise<string> {
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO photo (account_id, key, blurhash, width, height, state, position)
     VALUES ($1, $2, $3, 800, 1067, $4, $5) RETURNING id`,
    [accountId, key, BLURHASH, state, position],
  );
  return rows[0]?.id ?? "";
}

async function storedVariants(store: MediaStore, key: string) {
  for (const variant of PHOTO_VARIANTS)
    await store.put(objectKey(key, variant), new Uint8Array([1]), "image/webp");
}

describe("erasing the photo rows", () => {
  test("every photo, fetch-log and shown row of the account goes, with the content keys; nobody else's", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    const mine = [
      await photoOf(ctx, a.accountId, "k-a1"),
      await photoOf(ctx, a.accountId, "k-a2", "pending", 1),
    ];
    const theirs = await photoOf(ctx, b.accountId, "k-b1");
    await ctx.client.query(
      `INSERT INTO photo_access (account_id, photo_id, variant, at)
       VALUES ($1, $2, 'thumb', now()), ($1, $3, 'card', now()), ($4, $3, 'thumb', now())`,
      [a.accountId, mine[0], theirs, b.accountId],
    );
    await ctx.client.query(
      "INSERT INTO card_shown (account_id, photo_id, at) VALUES ($1, $2, now()), ($3, $4, now())",
      [a.accountId, theirs, b.accountId, mine[0]],
    );

    const erased = await erasePhotosOfAccount(ctx.client, a.accountId);
    expect(erased).toMatchObject({ photos: 2, accessRows: 2, shownRows: 1 });
    expect([...erased.keys].sort()).toEqual(["k-a1", "k-a2"]);

    const left = async (table: string) =>
      (await ctx.client.query(`SELECT account_id FROM ${table}`)).rows.map((r) => r.account_id);
    expect(await left("photo")).toEqual([b.accountId]);
    expect(await left("photo_access")).toEqual([b.accountId]);
    // B's record of having been shown A's photo went with A's photo.
    expect(await left("card_shown")).toEqual([]);
  });

  test("an account with no photos erases nothing and names no key", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    expect(await erasePhotosOfAccount(ctx.client, a.accountId)).toEqual({
      photos: 0,
      accessRows: 0,
      shownRows: 0,
      keys: [],
    });
  });
});

describe("deleting the objects after the commit", () => {
  test("only the objects no row holds any more go; another account's copy of the same picture stays", async ({
    ctx,
  }) => {
    const { logger, lines } = await captureLogger();
    const { store } = testMediaDeps();
    const other = await signedInAccount(ctx.client);
    await photoOf(ctx, other.accountId, "k-shared");
    for (const key of ["k-gone", "k-shared"]) await storedVariants(store, key);

    const deleted = await deleteOrphanedObjects(
      { db: ctx.client, store, logger },
      ["k-gone", "k-shared", "k-gone"],
      { accountId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b" },
    );
    expect(deleted).toBe(3);
    expect([...store.objects.keys()].sort()).toEqual(
      PHOTO_VARIANTS.map((v) => objectKey("k-shared", v)).sort(),
    );
    expect(lines().filter((l) => l.level === 50)).toEqual([]);
  });

  test("no keys, or keys every one of which another row still holds, delete nothing and ask the bucket nothing", async ({
    ctx,
  }) => {
    const { logger, lines } = await captureLogger();
    const asked: string[][] = [];
    const store: MediaStore = {
      put: async () => undefined,
      get: async () => null,
      delete: async (keys) => {
        asked.push(keys);
      },
    };
    const other = await signedInAccount(ctx.client);
    await photoOf(ctx, other.accountId, "k-held");
    const deps = { db: ctx.client, store, logger };
    const context = { accountId: other.accountId };
    expect(await deleteOrphanedObjects(deps, [], context)).toBe(0);
    expect(await deleteOrphanedObjects(deps, ["k-held"], context)).toBe(0);
    expect(asked).toEqual([]);
    expect(lines().filter((l) => l.level === 50)).toEqual([]);
  });

  test("a bucket that fails is logged with the account and the content keys, and erasure goes on", async ({
    ctx,
  }) => {
    const { logger, lines } = await captureLogger();
    const store: MediaStore = {
      put: async () => undefined,
      get: async () => null,
      delete: async () => {
        throw new Error("InternalError");
      },
    };
    const a = await signedInAccount(ctx.client);
    expect(
      await deleteOrphanedObjects({ db: ctx.client, store, logger }, ["k-lost"], {
        accountId: a.accountId,
      }),
    ).toBe(0);
    expect(lines().find((l) => l.msg === "erasure: deleting photo objects failed")).toMatchObject({
      accountId: a.accountId,
      keys: ["k-lost"],
      objects: 3,
    });
  });
});

describe("the export of the photos", () => {
  async function serviceDeps(ctx: TestContext, budget = { thumb: 10, card: 10, full: 10 }) {
    await withMatchingConfig(ctx.client, { photo_fetches_per_day: budget });
    const { logger } = await captureLogger();
    const { deps } = testMediaDeps();
    const service: PhotoServiceDeps = { ...deps, db: ctx.client, logger, now: () => new Date() };
    return service;
  }

  test("each photo with its URLs and its moderation outcome, never the labels, and the export's own fetches in the log", async ({
    ctx,
  }) => {
    const deps = await serviceDeps(ctx);
    const a = await signedInAccount(ctx.client);
    const staff = await staffSession(ctx.client);
    const byStaff = await photoOf(ctx, a.accountId, "k-staff", "rejected", 0);
    const byMachine = await photoOf(ctx, a.accountId, "k-machine", "approved", 1);
    const unchecked = await photoOf(ctx, a.accountId, "k-unchecked", "pending", 2);
    await ctx.client.query(
      `INSERT INTO photo_review (photo_id, labels, faces, flagged, decision, decided_by, decided_at, reason)
       VALUES ($1, '[{"name":"Suggestive","parentName":"","confidence":80}]', 1, '{Suggestive}', 'rejected', $2, '2026-10-01T10:00:00Z', 'nudity'),
              ($3, '[]', 1, '{}', 'approved', NULL, NULL, NULL)`,
      [byStaff, staff.identityId, byMachine],
    );

    const exported = await exportPhotos(deps, a.accountId);
    expect(exported.photos.map((p) => p.id)).toEqual([byStaff, byMachine, unchecked]);
    expect(exported.photos[0]?.review).toEqual({
      decision: "rejected",
      reason: "nudity",
      decidedByStaff: true,
      decidedAt: "2026-10-01T10:00:00.000Z",
    });
    expect(exported.photos[1]?.review).toEqual({
      decision: "approved",
      reason: null,
      decidedByStaff: false,
      decidedAt: null,
    });
    expect(exported.photos[2]?.review).toBeNull();
    for (const photo of exported.photos) {
      expect(Object.keys(photo.urls ?? {}).sort()).toEqual(["card", "full", "thumb"]);
    }
    expect(JSON.stringify(exported)).not.toContain("Suggestive");
    // Nine URLs issued, nine rows in the fetch log the export returns.
    expect(exported.accessLog).toHaveLength(9);
    expect(new Set(exported.accessLog.map((e) => e.photoId))).toEqual(
      new Set([byStaff, byMachine, unchecked]),
    );
  });

  test("over the day's budget the photo is still listed, without URLs", async ({ ctx }) => {
    const deps = await serviceDeps(ctx, { thumb: 10, card: 0, full: 10 });
    const a = await signedInAccount(ctx.client);
    const id = await photoOf(ctx, a.accountId, "k-budget");
    const exported = await exportPhotos(deps, a.accountId);
    expect(exported.photos).toHaveLength(1);
    expect(exported.photos[0]).toMatchObject({ id, urls: null });
    // The two variants within the budget were fetched and are in the log; the card was not.
    expect(exported.accessLog.map((e) => e.variant).sort()).toEqual(["full", "thumb"]);
  });

  test("without object storage the photos are listed without URLs and nothing is fetched", async ({
    ctx,
  }) => {
    const { logger } = await captureLogger();
    const a = await signedInAccount(ctx.client);
    const id = await photoOf(ctx, a.accountId, "k-nostore");
    const exported = await exportPhotos(
      { db: ctx.client, logger, now: () => new Date() },
      a.accountId,
    );
    expect(exported).toEqual({
      photos: [expect.objectContaining({ id, urls: null, review: null })],
      accessLog: [],
    });
  });

  test("a failure other than the budget fails the export rather than hiding a photo's URLs", async ({
    ctx,
  }) => {
    const deps = await serviceDeps(ctx);
    const a = await signedInAccount(ctx.client);
    await photoOf(ctx, a.accountId, "k-signer");
    const broken: PhotoServiceDeps = {
      ...deps,
      signer: {
        sign: async () => {
          throw new Error("the signing key is unreadable");
        },
      },
    };
    await expect(exportPhotos(broken, a.accountId)).rejects.toThrow(
      "the signing key is unreadable",
    );
  });

  test("another account's photos and fetches are never in the export", async ({ ctx }) => {
    const deps = await serviceDeps(ctx);
    const a = await signedInAccount(ctx.client, "a");
    const b = await signedInAccount(ctx.client, "b");
    await photoOf(ctx, b.accountId, "k-theirs");
    await ctx.client.query(
      "INSERT INTO photo_access (account_id, photo_id, variant, at) SELECT $1, id, 'thumb', now() FROM photo WHERE account_id = $1",
      [b.accountId],
    );
    expect(await exportPhotos(deps, a.accountId)).toEqual({ photos: [], accessLog: [] });
  });
});
