import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  manifestOf,
  PERSONA_CONVERSATIONS,
  PERSONA_HISTORIES,
  type PhotoAsset,
} from "@kuutti/db/demo";
import sharp from "sharp";
import { afterAll } from "vitest";
import { hmacKeyFromHex } from "../../src/identity/index.ts";
import { listApprovedPhotos, objectKey } from "../../src/media/index.ts";
import { signedInAccount } from "../../src/test/account.ts";
import { captureLogger, describe, expect, type TestContext, test } from "../../src/test/harness.ts";
import { fixtureJpeg, fixturePng, testMediaDeps } from "../../src/test/media.ts";
import { DemoError } from "./bank.ts";
import { giveConversations, givePhotoMessages } from "./histories.ts";
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
    `INSERT INTO ponds (slug, name_nominative, name_inessive) VALUES ('paakaupunkiseutu', 'Pääkaupunkiseutu', 'Pääkaupunkiseudulla')
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
    expect(() => picturesOf({ dir, manifest }, { key: "sanna", photos: 6 })).toThrow(
      /has 5 pictures of sanna, and the story needs 6/,
    );
    expect(() =>
      picturesOf({ dir, manifest }, { key: "noa", photos: 0, negatives: ["cartoon"] }),
    ).toThrow(/no negative cartoon/);
  });
});

describe("the stories' photos in their conversations (#350)", () => {
  test("give the chat's pair the story's photo, through the pipeline, once, and none without object storage", async ({
    ctx,
  }) => {
    const assets = await release();
    const { writer, store, media, logger } = await world(ctx, assets);
    // The round's cast (#379) has no conversation: its eleven faces through
    // the pipeline would only spend the test's time.
    const results = await giveStories(writer, ["iida", "henna", "katja", "minna", "riikka"]);
    await giveConversations(ctx.client, results, new Date());
    const story = PERSONA_CONVERSATIONS.find((c) => c.photo)?.photo;
    if (!story) throw new Error("no story with a photo");
    const deps = { db: ctx.client, logger, media: media.deps, assets };
    expect(await givePhotoMessages(deps, results, new Date())).toEqual({
      sent: 1,
      already: 0,
      skipped: 0,
    });
    const sent = await ctx.client.query(
      `SELECT m.seq, m.side, m.kind, m.body, p.purpose, p.position, p.key
       FROM message m JOIN photo p ON p.id = m.photo_id`,
    );
    expect(sent.rows).toEqual([
      {
        seq: 7,
        side: story.from,
        kind: "photo",
        body: story.caption,
        purpose: "message",
        position: null,
        key: expect.any(String),
      },
    ]);
    const full = store.objects.get(objectKey(sent.rows[0]?.key, "full"));
    const meta = await sharp(Buffer.from(full as Uint8Array)).metadata();
    expect([meta.format, meta.exif]).toEqual(["webp", undefined]);
    // A second run is answered with the stored message.
    expect(await givePhotoMessages(deps, results, new Date())).toEqual({
      sent: 0,
      already: 1,
      skipped: 0,
    });
    // Without object storage, or with no pictures, none; a release without the picture is refused.
    expect(
      await givePhotoMessages({ db: ctx.client, logger, assets }, results, new Date()),
    ).toEqual({ sent: 0, already: 0, skipped: 1 });
    expect(await givePhotoMessages({ ...deps, assets: null }, results, new Date())).toEqual({
      sent: 0,
      already: 0,
      skipped: 1,
    });
    await expect(
      givePhotoMessages(
        { ...deps, assets: { dir: assets.dir, manifest: [] } },
        results,
        new Date(),
      ),
    ).rejects.toThrow(/no negatives\/no-face\.jpg/);
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
      sanna: 5,
      onni: 0,
      noa: 6,
      kerttu: 4,
      tapio: 0,
      ilona: 0,
      helmi: 0,
      antti: 0,
      ville: 0,
      elina: 0,
      jussi: 0,
      laura: 0,
      emmi: 0,
      iida: 3,
      henna: 2,
      katja: 2,
      minna: 2,
      riikka: 2,
    });
    const sanna = await photosOf(ctx, "sanna");
    expect(sanna).toHaveLength(5);
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
    // Every story's pictures through sharp, the round's cast's eleven too
    // (#379): about thirteen seconds under CI's coverage, over the default.
  }, 60_000);

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
