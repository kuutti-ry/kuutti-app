import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestOf, PERSONA_HISTORIES, type PhotoAsset } from "@kuutti/db/demo";
import sharp from "sharp";
import { afterAll } from "vitest";
import { hmacKeyFromHex } from "../../src/identity/index.ts";
import { listApprovedPhotos, objectKey } from "../../src/media/index.ts";
import { signedInAccount } from "../../src/test/account.ts";
import { captureLogger, describe, expect, type TestContext, test } from "../../src/test/harness.ts";
import { fixtureJpeg, fixturePng, testMediaDeps } from "../../src/test/media.ts";
import { DemoError } from "./bank.ts";
import { approveLocally, loadAssets, picturesOf, uploadFaces } from "./photos.ts";
import { giveStories, viaServices } from "./services.ts";

// The demo's pictures through the pipeline (#142): a release made of fixture
// images in a temporary directory, its manifest from the same function the
// maintainer's command uses, and the stories given with it.

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A release with the personas' sets as the stories count them, two pool faces and the four negatives. */
async function release(): Promise<{ dir: string; manifest: PhotoAsset[] }> {
  const dir = mkdtempSync(join(tmpdir(), "kuutti-release-"));
  dirs.push(dir);
  const put = (path: string, bytes: Buffer) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  };
  for (const history of PERSONA_HISTORIES) {
    for (let i = 1; i <= history.photos; i += 1) {
      put(
        `faces/${history.key}/${i}.jpg`,
        await fixtureJpeg({ exif: false, width: 600 + i, height: 800 }),
      );
    }
  }
  put("faces/pool/001.jpg", await fixtureJpeg({ exif: false, width: 601, height: 801 }));
  put("faces/pool/002.png", await fixturePng(640, 480));
  put("negatives/no-face.jpg", await fixtureJpeg({ exif: false, width: 700, height: 500 }));
  put("negatives/several-people.jpg", await fixtureJpeg({ exif: false, width: 701, height: 500 }));
  put("negatives/text.png", await fixturePng(300, 200));
  // A camera's EXIF with a GPS position: the pipeline strips it (rule 4).
  put("negatives/exif-location.jpg", await fixtureJpeg({ exif: true }));
  put("PROVENANCE.md", Buffer.from("fixtures"));
  return { dir, manifest: manifestOf(dir) };
}

async function world(ctx: TestContext, assets: { dir: string; manifest: PhotoAsset[] }) {
  const { logger, lines } = await captureLogger();
  await ctx.client.query(
    `INSERT INTO ponds (slug, name_nominative, name_inessive) VALUES ('suomi', 'Suomi', 'Suomessa')
     ON CONFLICT (slug) DO NOTHING`,
  );
  const media = testMediaDeps({ concurrency: 2 });
  const writer = viaServices({
    db: ctx.client,
    logger,
    now: () => new Date(),
    hmacKey: hmacKeyFromHex(randomBytes(32).toString("hex")),
    media: media.deps,
    assets,
  });
  return { writer, store: media.store, media, logger, lines };
}

const photosOf = (ctx: TestContext, key: string) =>
  ctx.client
    .query<{ id: string; state: string; key: string; blurhash: string }>(
      `SELECT p.id, p.state, p.key, p.blurhash FROM photo p
         JOIN account a ON a.id = p.account_id JOIN identity i ON i.id = a.identity_id
       WHERE i.broker_subject = $1 ORDER BY p.position`,
      [`kuutti-demo:${key}`],
    )
    .then((r) => r.rows);

describe("the release in the cache", () => {
  test("is used only whole and untouched, and a story asks for what the release has", async () => {
    const { dir, manifest } = await release();
    expect(loadAssets(dir, manifest)).toEqual({ dir, manifest });
    expect(loadAssets(dir, [])).toBeNull();
    writeFileSync(join(dir, "faces/sanna/1.jpg"), "not the picture");
    expect(() => loadAssets(dir, manifest)).toThrow(DemoError);
    expect(() => loadAssets(dir, manifest)).toThrow(
      /faces\/sanna\/1\.jpg tampered.*pnpm demo:assets/,
    );
    const sanna = picturesOf({ dir, manifest }, { key: "sanna", photos: 3 });
    expect(sanna.faces).toHaveLength(3);
    expect(sanna.negatives).toHaveLength(0);
    expect(() => picturesOf({ dir, manifest }, { key: "sanna", photos: 4 })).toThrow(
      /has 3 pictures of sanna, and the story needs 4/,
    );
    expect(() =>
      picturesOf({ dir, manifest }, { key: "noa", photos: 0, negatives: ["cartoon"] }),
    ).toThrow(/no negative cartoon/);
  });
});

describe("the stories with their pictures", () => {
  test("give each persona the pictures its story counts, through the pipeline, with the EXIF gone and the negatives left to the queue", async ({
    ctx,
  }) => {
    const assets = await release();
    const { writer, store } = await world(ctx, assets);
    const results = await giveStories(writer);
    expect(Object.fromEntries(results.map((r) => [r.key, r.photos]))).toEqual({
      sanna: 3,
      onni: 0,
      noa: 6,
      kerttu: 3,
      tapio: 0,
      ilona: 0,
    });
    const sanna = await photosOf(ctx, "sanna");
    expect(sanna).toHaveLength(3);
    // No check is configured in this world: the pictures wait for one, and
    // the services writer approves nothing by hand (the container's check decides).
    expect(sanna.every((p) => p.state === "pending" && p.blurhash.length > 0)).toBe(true);
    const noa = await photosOf(ctx, "noa");
    expect(noa).toHaveLength(6);
    // Every stored variant is a WebP without EXIF, the GPS position of the negative included.
    for (const photo of [...sanna, ...noa]) {
      const card = store.objects.get(objectKey(photo.key, "card"));
      expect(card, photo.id).toBeDefined();
      const meta = await sharp(Buffer.from(card as Uint8Array)).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.exif).toBeUndefined();
    }
    // A second run resumes and uploads nothing more.
    const again = await giveStories(writer);
    expect(again.every((r) => r.photos === 0)).toBe(true);
    expect(await photosOf(ctx, "noa")).toHaveLength(6);
  });

  test("the look a moderator gives, locally: the faces named are approved, the rest and other accounts untouched", async ({
    ctx,
  }) => {
    const assets = await release();
    const { writer } = await world(ctx, assets);
    await giveStories(writer);
    const noa = await photosOf(ctx, "noa");
    const faces = noa.slice(0, 2).map((p) => p.id);
    const { rows } = await ctx.client.query<{ id: string }>(
      "SELECT account_id AS id FROM photo WHERE id = $1",
      [faces[0]],
    );
    const accountId = rows[0]?.id as string;
    expect(await approveLocally(ctx.client, accountId, faces)).toBe(2);
    expect(await listApprovedPhotos(ctx.client, accountId)).toHaveLength(2);
    expect((await photosOf(ctx, "noa")).map((p) => p.state)).toEqual([
      "approved",
      "approved",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    // Somebody else's account, the same ids: nothing moves.
    const other = await signedInAccount(ctx.client);
    expect(await approveLocally(ctx.client, other.accountId, faces)).toBe(0);
    expect(await approveLocally(ctx.client, accountId, [])).toBe(0);
  });

  test("the population's faces go through the pipeline per person, one copy per face, approved where no check decides", async ({
    ctx,
  }) => {
    const assets = await release();
    const { media, logger } = await world(ctx, assets);
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const pool = assets.manifest.filter((asset) => asset.purpose === "pool");
    const faces = new Map<string, readonly PhotoAsset[]>([
      [a.accountId, pool],
      [b.accountId, pool.slice(0, 1)],
    ]);
    const deps = { ...media.deps, db: ctx.client, logger, now: () => new Date() };
    expect(await uploadFaces(deps, assets, faces, { approve: true })).toEqual({
      people: 2,
      photos: 3,
      approved: 3,
    });
    expect(await listApprovedPhotos(ctx.client, a.accountId)).toHaveLength(2);
    expect(await listApprovedPhotos(ctx.client, b.accountId)).toHaveLength(1);
    // The same face for two people is one content address: three objects, not six.
    const keys = new Set([...media.store.objects.keys()].map((k) => k.split("/")[1]));
    expect(keys.size).toBe(2);
    expect(await uploadFaces(deps, assets, new Map(), { approve: false })).toEqual({
      people: 0,
      photos: 0,
      approved: 0,
    });
  });
});
