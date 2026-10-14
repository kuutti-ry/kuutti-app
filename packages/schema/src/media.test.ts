import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  PHOTO_MAX_BYTES,
  PHOTO_VARIANT_SIZES,
  PHOTO_VARIANTS,
  Photo,
  PhotoFetchBudget,
  PhotoId,
  PhotoList,
  PhotoOrderRequest,
  PhotoParams,
  PhotoRejectionReason,
  PhotoState,
  PhotoUploadRequest,
  PhotoUrlResponse,
  PhotoVariantParams,
  TipKind,
} from "./media.ts";

// Photos (#48, rule 4): the upload's file at its size and type bounds, what
// the owner reads back, the order and the per-variant fetch budget.

const codes = (schema: z.ZodType, input: unknown) =>
  schema.safeParse(input).error?.issues.map((issue) => issue.code) ?? [];

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-01T12:00:00.000Z";

// The package's lib has no DOM; Node 22 has File as a global all the same.
const NodeFile = (
  globalThis as unknown as {
    File: new (bits: Uint8Array[], name: string, options: { type: string }) => object;
  }
).File;
const file = (bytes: number, type: string) =>
  new NodeFile([new Uint8Array(bytes)], "photo", { type });

describe("the upload", () => {
  it.each(["image/jpeg", "image/png", "image/webp"])("takes a %s picture", (type) => {
    const photo = file(16, type);
    expect(PhotoUploadRequest.parse({ photo }).photo).toBe(photo);
  });

  it.each(["image/gif", "image/heic", "application/pdf", "text/plain", ""])(
    "refuses the type %o before decoding",
    (type) => {
      expect(codes(PhotoUploadRequest, { photo: file(16, type) })).toEqual(["invalid_value"]);
    },
  );

  it("takes exactly ten mebibytes and refuses one byte more", () => {
    expect(PHOTO_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(
      PhotoUploadRequest.safeParse({ photo: file(PHOTO_MAX_BYTES, "image/jpeg") }).success,
    ).toBe(true);
    expect(codes(PhotoUploadRequest, { photo: file(PHOTO_MAX_BYTES + 1, "image/jpeg") })).toEqual([
      "too_big",
    ]);
  });

  it("refuses bytes sent as a string, no photo at all and an extra field", () => {
    expect(codes(PhotoUploadRequest, { photo: "data:image/jpeg;base64,AAAA" })).toEqual([
      "invalid_type",
    ]);
    expect(codes(PhotoUploadRequest, {})).toEqual(["invalid_type"]);
    expect(codes(PhotoUploadRequest, { photo: file(16, "image/png"), position: "0" })).toEqual([
      "unrecognized_keys",
    ]);
  });
});

describe("the variants", () => {
  it("are thumb, card and full, each with its fixed size", () => {
    expect(PHOTO_VARIANTS).toEqual(["thumb", "card", "full"]);
    expect(Object.keys(PHOTO_VARIANT_SIZES)).toEqual([...PHOTO_VARIANTS]);
    expect(PHOTO_VARIANT_SIZES.card).toEqual({ width: 800, height: 1067 });
  });

  it("are asked for by the photo's id and a known variant", () => {
    expect(PhotoVariantParams.parse({ id: uuid(1), variant: "full" })).toEqual({
      id: uuid(1),
      variant: "full",
    });
    expect(codes(PhotoVariantParams, { id: uuid(1), variant: "original" })).toEqual([
      "invalid_value",
    ]);
    expect(codes(PhotoParams, { id: "../etc/passwd" })).toEqual(["invalid_format"]);
  });
});

describe("a photo as its owner reads it", () => {
  const photo = {
    id: uuid(1),
    blurhash: "LEHV6n",
    width: 1200,
    height: 1600,
    state: "pending",
    rejectionReason: null,
    appealable: false,
    position: 0,
    createdAt: at,
  };

  it("parses with its id branded", () => {
    const parsed = Photo.parse(photo);
    expect(parsed).toEqual(photo);
    const id: PhotoId = parsed.id;
    expect(PhotoId.parse(id)).toBe(uuid(1));
  });

  it.each(["pending", "approved", "queued", "rejected"])("may be %s", (state) => {
    expect(PhotoState.parse(state)).toBe(state);
  });

  it("names a rejection's reason from the closed list", () => {
    expect(PhotoRejectionReason.options).toHaveLength(7);
    expect(
      Photo.parse({ ...photo, state: "rejected", rejectionReason: "other" }).rejectionReason,
    ).toBe("other");
  });

  it.each([
    ["a blurhash of five characters", { blurhash: "LEHV6" }, "too_small"],
    ["a blurhash of 201 characters", { blurhash: "L".repeat(201) }, "too_big"],
    ["a width of zero", { width: 0 }, "too_small"],
    ["a negative height", { height: -1 }, "too_small"],
    ["a negative position", { position: -1 }, "too_small"],
    ["a fractional position", { position: 0.5 }, "invalid_type"],
    ["an unknown state", { state: "hidden" }, "invalid_value"],
    ["an unknown reason", { rejectionReason: "blurry" }, "invalid_value"],
    ["a date that is not ISO 8601", { createdAt: "yesterday" }, "invalid_format"],
  ])("refuses %s", (_, change, code) => {
    expect(codes(Photo, { ...photo, ...change })).toEqual([code]);
  });

  it("takes a blurhash of six and of two hundred characters", () => {
    expect(Photo.safeParse({ ...photo, blurhash: "L".repeat(200) }).success).toBe(true);
  });

  it("lists at most fifty photos and a positive maximum", () => {
    expect(
      PhotoList.parse({ photos: Array(50).fill(photo), maxPhotos: 6, tips: [] }).photos,
    ).toHaveLength(50);
    expect(codes(PhotoList, { photos: Array(51).fill(photo), maxPhotos: 6, tips: [] })).toEqual([
      "too_big",
    ]);
    expect(codes(PhotoList, { photos: [], maxPhotos: 0, tips: [] })).toEqual(["too_small"]);
  });

  it("carries the tips, and the fish of the fish tip from Finland's and nearby waters only (#253, #287)", () => {
    const list = { photos: [photo], maxPhotos: 6, tips: ["fish"], fishSpecies: "pike" };
    expect(PhotoList.parse(list)).toEqual(list);
    expect(PhotoList.parse({ ...list, fishSpecies: null }).fishSpecies).toBeNull();
    // An API older than the fish's species (#253) sends none: read as null.
    expect(PhotoList.parse({ photos: [photo], maxPhotos: 6, tips: ["few_photos"] })).toEqual({
      photos: [photo],
      maxPhotos: 6,
      tips: ["few_photos"],
      fishSpecies: null,
    });
    expect(codes(PhotoList, { ...list, fishSpecies: "tuna" })).toEqual(["invalid_value"]);
    expect(codes(PhotoList, { photos: [photo], maxPhotos: 6 })).toEqual(["invalid_type"]);
  });

  it.each([
    "sunglasses",
    "mirror_selfie",
    "tight_crop",
    "group_photo",
    "poor_lighting",
    "blurry",
    "few_photos",
    "revealing",
    "fish",
  ])("names the tip %s", (tip) => {
    expect(TipKind.parse(tip)).toBe(tip);
  });

  it("refuses an unknown tip", () => {
    expect(codes(TipKind, "smile_more")).toEqual(["invalid_value"]);
  });
});

describe("the order of the photos", () => {
  it("takes from one to fifty ids", () => {
    expect(PhotoOrderRequest.parse({ order: [uuid(1)] })).toEqual({ order: [uuid(1)] });
    const fifty = Array.from({ length: 50 }, (_, i) => uuid(i));
    expect(PhotoOrderRequest.safeParse({ order: fifty }).success).toBe(true);
  });

  it("refuses an empty order, fifty-one ids, an id that is not a uuid and an extra key", () => {
    expect(codes(PhotoOrderRequest, { order: [] })).toEqual(["too_small"]);
    expect(
      codes(PhotoOrderRequest, { order: Array.from({ length: 51 }, (_, i) => uuid(i)) }),
    ).toEqual(["too_big"]);
    expect(codes(PhotoOrderRequest, { order: ["1"] })).toEqual(["invalid_format"]);
    expect(codes(PhotoOrderRequest, { order: [uuid(1)], main: uuid(1) })).toEqual([
      "unrecognized_keys",
    ]);
  });
});

describe("a signed URL", () => {
  it("names the variant and when it ends", () => {
    const signed = { url: "https://media.example.com/x?sig=1", variant: "thumb", expiresAt: at };
    expect(PhotoUrlResponse.parse(signed)).toEqual(signed);
    expect(codes(PhotoUrlResponse, { ...signed, url: "media/x" })).toEqual(["invalid_format"]);
  });
});

describe("the fetch budget of matching_config", () => {
  it("names a whole, non-negative number per variant", () => {
    const budget = { thumb: 600, card: 200, full: 0 };
    expect(PhotoFetchBudget.parse(budget)).toEqual(budget);
  });

  it.each([
    ["a negative count", { thumb: -1, card: 1, full: 1 }, "too_small"],
    ["a fractional count", { thumb: 1, card: 1.5, full: 1 }, "invalid_type"],
    ["a variant left out", { thumb: 1, card: 1 }, "invalid_type"],
    ["an unknown variant", { thumb: 1, card: 1, full: 1, original: 1 }, "unrecognized_keys"],
  ])("refuses %s", (_, budget, code) => {
    expect(codes(PhotoFetchBudget, budget)).toEqual([code]);
  });
});
