import { createHash } from "node:crypto";
import { PHOTO_MAX_INPUT_PIXELS, PHOTO_VARIANT_SIZES, type PhotoVariant } from "@kuutti/schema";
import { encode as encodeBlurhash } from "blurhash";
import sharp, { type Sharp } from "sharp";

// The photo pipeline (#48, rule 4, rules/api.md Media): bytes in, three WebP
// variants out, nothing kept of the input. sharp re-encodes, which drops EXIF,
// XMP, IPTC and the ICC profile (colours are converted to sRGB first) and bakes
// the EXIF orientation into the pixels. sharp is imported at module level on
// purpose: a runtime image whose native binary is missing fails at boot, not
// at the first upload.

export type PipelineFailure = "unsupported" | "too_many_pixels" | "invalid";

export class PipelineError extends Error {
  constructor(
    readonly reason: PipelineFailure,
    message: string,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

export type ImageHeader = { format: "jpeg" | "png" | "webp"; width: number; height: number };

/**
 * Format and dimensions from the file header alone, without a decoder: the
 * pixel cap is applied here, so a 40-megapixel upload is refused before sharp
 * is asked anything (security checklist, "Mishandling of exceptional
 * conditions"). Null means the header is not one we accept.
 */
export function inspectImage(bytes: Uint8Array): ImageHeader | null {
  return readPng(bytes) ?? readJpeg(bytes) ?? readWebp(bytes);
}

function readPng(b: Uint8Array): ImageHeader | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !signature.every((v, i) => b[i] === v)) return null;
  if (String.fromCharCode(...b.subarray(12, 16)) !== "IHDR") return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { format: "png", width: view.getUint32(16), height: view.getUint32(20) };
}

function readJpeg(b: Uint8Array): ImageHeader | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let offset = 2;
  while (offset + 4 <= b.length) {
    if (b[offset] !== 0xff) return null;
    const marker = b[offset + 1] ?? 0;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2; // standalone markers carry no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image or scan before any frame header
    const length = view.getUint16(offset + 2);
    if (length < 2) return null;
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (offset + 9 > b.length) return null;
      return {
        format: "jpeg",
        height: view.getUint16(offset + 5),
        width: view.getUint16(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

function readWebp(b: Uint8Array): ImageHeader | null {
  if (b.length < 30) return null;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WEBP") return null;
  const chunk = ascii(12, 16);
  const at = (i: number) => b[i] ?? 0;
  if (chunk === "VP8 ") {
    return {
      format: "webp",
      width: (at(26) | (at(27) << 8)) & 0x3fff,
      height: (at(28) | (at(29) << 8)) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    const b0 = at(21);
    const b1 = at(22);
    const b2 = at(23);
    const b3 = at(24);
    return {
      format: "webp",
      width: 1 + (b0 | ((b1 & 0x3f) << 8)),
      height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
    };
  }
  if (chunk === "VP8X") {
    return {
      format: "webp",
      width: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)),
      height: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)),
    };
  }
  return null;
}

export type ProcessedPhoto = {
  /** Hex SHA-256 of the full variant: the content address the objects live under. */
  key: string;
  variants: Record<PhotoVariant, Buffer>;
  /** Of the full variant, after orientation. */
  width: number;
  height: number;
  blurhash: string;
};

const WEBP_QUALITY = { thumb: 80, card: 82, full: 85 } as const;

/**
 * The whole pipeline for one upload. Throws PipelineError with a reason the
 * route maps to a status; anything else from sharp is a decoder failure and
 * reads as `invalid`. The caller owns the concurrency limit.
 */
export async function processPhoto(bytes: Uint8Array): Promise<ProcessedPhoto> {
  const header = inspectImage(bytes);
  if (!header) throw new PipelineError("unsupported", "Not a JPEG, PNG or WebP header");
  if (header.width * header.height > PHOTO_MAX_INPUT_PIXELS) {
    throw new PipelineError(
      "too_many_pixels",
      `${header.width}×${header.height} is over ${PHOTO_MAX_INPUT_PIXELS} pixels`,
    );
  }

  let input: Sharp;
  try {
    // limitInputPixels is the decoder-side backstop of the header check above;
    // animated: false takes the first page of anything multi-page; rotate()
    // without an angle applies the EXIF orientation, which is then gone with
    // the rest of the metadata.
    input = sharp(bytes, { limitInputPixels: PHOTO_MAX_INPUT_PIXELS, animated: false }).rotate();
    await input.metadata(); // decodes the header through libvips; a lying header fails here
  } catch (error) {
    throw new PipelineError("invalid", `sharp could not read the image: ${reasonOf(error)}`);
  }

  try {
    const full = await input
      .clone()
      .resize({
        width: PHOTO_VARIANT_SIZES.full.longEdge,
        height: PHOTO_VARIANT_SIZES.full.longEdge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY.full })
      .toBuffer({ resolveWithObject: true });
    // The smaller variants are cut from the full one: same pixels, one decode of the input.
    const fromFull = sharp(full.data);
    const card = await fromFull
      .clone()
      .resize({ ...PHOTO_VARIANT_SIZES.card, fit: "cover", position: sharp.strategy.attention })
      .webp({ quality: WEBP_QUALITY.card })
      .toBuffer();
    // A thumb must show only the crop the profile's check saw (ADR-006 §1).
    const thumb = await sharp(card)
      .resize({ ...PHOTO_VARIANT_SIZES.thumb, fit: "cover", position: sharp.strategy.attention })
      .webp({ quality: WEBP_QUALITY.thumb })
      .toBuffer();
    return {
      key: createHash("sha256").update(full.data).digest("hex"),
      variants: { thumb, card, full: full.data },
      width: full.info.width,
      height: full.info.height,
      blurhash: await blurhashOf(thumb),
    };
  } catch (error) {
    throw new PipelineError("invalid", `sharp could not decode the image: ${reasonOf(error)}`);
  }
}

/** 4×3 components from a 32 px reduction of the thumb: about 30 characters, paints in a millisecond. */
async function blurhashOf(thumb: Buffer): Promise<string> {
  const { data, info } = await sharp(thumb)
    .resize({ width: 32, height: 32, fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return encodeBlurhash(new Uint8ClampedArray(data), info.width, info.height, 4, 3);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
