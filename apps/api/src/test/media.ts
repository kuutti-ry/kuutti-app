import { generateKeyPairSync } from "node:crypto";
import pLimit from "p-limit";
import sharp from "sharp";
import type { Inspection, Moderator } from "../media/index.ts";
import { cloudFrontSigner, type MediaDeps, memoryMediaStore } from "../media/index.ts";

/**
 * Test fixtures for the photo pipeline (#48). Images are made with sharp at
 * test time, so nothing binary is committed and every fixture says what it
 * is; the one hand-built header (a JPEG claiming 40 megapixels) exists to
 * prove the pixel cap is applied before any decoder runs.
 */

/** A photo-like picture: a gradient with a bright disc, so the attention crop has something to find. */
export async function fixtureJpeg(
  options: { width?: number; height?: number; exif?: boolean; orientation?: number } = {},
): Promise<Buffer> {
  const width = options.width ?? 1200;
  const height = options.height ?? 1600;
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
       <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
         <stop offset="0" stop-color="#1D4FD7"/><stop offset="1" stop-color="#F59E0B"/>
       </linearGradient></defs>
       <rect width="100%" height="100%" fill="url(#g)"/>
       <circle cx="${width * 0.6}" cy="${height * 0.35}" r="${Math.min(width, height) * 0.15}" fill="#fff"/>
     </svg>`,
  );
  let image = sharp(svg).jpeg({ quality: 90 });
  if (options.exif !== false) {
    // EXIF with GPS, the way a phone camera writes it; withExif keeps it on
    // the output, and withMetadata writes the orientation tag as a proper
    // SHORT (a string in IFD0 would not be read as an orientation).
    image = image.withMetadata({ orientation: options.orientation ?? 1 }).withExif({
      IFD0: {
        Make: "Kuutti Fixture",
        Model: "Test Camera",
        Software: "fixture",
      },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "60/1 10/1 1234/100",
        GPSLongitudeRef: "E",
        GPSLongitude: "24/1 56/1 5678/100",
      },
    });
  }
  return image.toBuffer();
}

export async function fixturePng(width = 640, height = 480): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#22c55e" } })
    .png()
    .toBuffer();
}

export async function fixtureWebp(width = 640, height = 480, lossless = false): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#a855f7" } })
    .webp({ lossless })
    .toBuffer();
}

export async function fixtureGif(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 64, channels: 3, background: "#000" } })
    .gif()
    .toBuffer();
}

/** A JPEG start-of-image and frame header for 8000×5000 (40 MP), no scan data: a header, not a picture. */
export function fixtureHugeJpegHeader(): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00, // APP0 JFIF
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    0x13,
    0x88,
    0x1f,
    0x40,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01, // SOF0 5000 high, 8000 wide
    0xff,
    0xd9, // EOI
  ]);
}

/** An RSA pair as CloudFront wants it (2048, PKCS#1 or PKCS#8 PEM). Made once per test file. */
export function testSigningKeys(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export const TEST_KEY_PAIR_ID = "K2JCJMDEHXQW5F";
export const TEST_MEDIA_BASE = "https://api.test";

/** A memory store, a CloudFront signer over a fresh test key, and a limit of `concurrency`. */
export function testMediaDeps(options: { concurrency?: number; deliverUnchecked?: boolean } = {}) {
  const store = memoryMediaStore();
  const keys = testSigningKeys();
  const deps: MediaDeps = {
    store,
    signer: cloudFrontSigner({
      baseUrl: TEST_MEDIA_BASE,
      keyPairId: TEST_KEY_PAIR_ID,
      privateKey: keys.privateKey,
    }),
    limit: pLimit(options.concurrency ?? 2),
    // A test is a developer's machine: a photo no check saw is delivered (#350).
    deliverUnchecked: options.deliverUnchecked ?? true,
  };
  return { deps, store, keys };
}

/**
 * What the check answers, written short: labels as `[name, confidence]`,
 * faces as confidences; `null` labels is a look that never ran.
 */
export function checked(
  labels: ReadonlyArray<readonly [string, number]> | null,
  faces: readonly number[] = [99],
): Inspection {
  return {
    checked: labels !== null,
    labels: (labels ?? []).map(([name, confidence]) => ({ name, parentName: "", confidence })),
    tipLabels: [],
    faceConfidences: [...faces],
    seen: { scene: [], face: null },
    modelVersion: labels === null ? null : "7.0",
    calls: labels === null ? 0 : 3,
  };
}

/** A moderator that answers each look with the next answer (the last again), or throws it; `seen` counts the bytes it was shown. */
export function scriptedModerator(...answers: Array<Inspection | Error>): Moderator & {
  seen: number[];
} {
  const seen: number[] = [];
  return {
    kind: "rekognition",
    seen,
    async inspect(image) {
      seen.push(image.length);
      const answer = answers[Math.min(seen.length - 1, answers.length - 1)];
      if (!answer) throw new Error("no answer scripted");
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}
