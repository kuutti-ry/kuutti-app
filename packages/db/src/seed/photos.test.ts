import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assetsFor,
  demoAssetsDir,
  facesForPopulation,
  manifestOf,
  negativesOf,
  purposeOf,
  renderManifest,
  verifyAssets,
} from "./photos.ts";
import { PHOTOS_MANIFEST } from "./photos-manifest.ts";
import { generatePopulation } from "./population.ts";

// The release's manifest and its checks (#142, ADR-014 §7). The "pictures"
// here are a few bytes with the right names: the manifest reads bytes, not
// images; the pipeline's own tests decode.

const dirs: string[] = [];
function release(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kuutti-photos-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const PICTURES = {
  "faces/sanna/1.jpg": "sanna one",
  "faces/sanna/2.jpg": "sanna two",
  "faces/pool/001.jpg": "pool one",
  "faces/pool/002.png": "pool two",
  "negatives/no-face.jpg": "a landscape",
  "PROVENANCE.md": "faces/sanna/1.jpg — a model, a date, p-sanna-1",
  LICENSE: "the terms",
};

describe("the release's layout", () => {
  it("says what each path is for, and nothing for a file outside it", () => {
    expect(purposeOf("faces/sanna/1.jpg")).toBe("persona:sanna");
    expect(purposeOf("faces/pool/017.jpg")).toBe("pool");
    expect(purposeOf("negatives/exif-location.jpg")).toBe("negative:exif-location");
    expect(purposeOf("faces/pool/002.PNG")).toBe("pool");
    expect(purposeOf("PROVENANCE.md")).toBeNull();
    expect(purposeOf("faces/sanna/notes.txt")).toBeNull();
    expect(purposeOf("faces/1.jpg")).toBeNull();
    expect(purposeOf("elsewhere/1.jpg")).toBeNull();
  });

  it("lists a directory of pictures, sorted, with the checksum of every one, and refuses a misplaced picture", () => {
    const dir = release(PICTURES);
    const manifest = manifestOf(dir);
    expect(manifest.map((a) => [a.path, a.purpose])).toEqual([
      ["faces/pool/001.jpg", "pool"],
      ["faces/pool/002.png", "pool"],
      ["faces/sanna/1.jpg", "persona:sanna"],
      ["faces/sanna/2.jpg", "persona:sanna"],
      ["negatives/no-face.jpg", "negative:no-face"],
    ]);
    expect(manifest.every((a) => /^[0-9a-f]{64}$/.test(a.sha256))).toBe(true);
    expect(assetsFor(manifest, "persona:sanna").map((a) => a.path)).toEqual([
      "faces/sanna/1.jpg",
      "faces/sanna/2.jpg",
    ]);
    expect([...negativesOf(manifest).keys()]).toEqual(["no-face"]);
    const misplaced = release({ ...PICTURES, "stray.jpg": "x" });
    expect(() => manifestOf(misplaced)).toThrow(/stray\.jpg: a picture outside/);
  });

  it("verifies a directory against the manifest: a tampered, a missing and an unlisted picture are each named", () => {
    const dir = release(PICTURES);
    const manifest = manifestOf(dir);
    expect(verifyAssets(dir, manifest)).toEqual([]);
    // One byte of one picture flipped.
    writeFileSync(join(dir, "faces/sanna/2.jpg"), "sanna twO");
    rmSync(join(dir, "faces/pool/001.jpg"));
    writeFileSync(join(dir, "faces/pool/099.jpg"), "added");
    expect(verifyAssets(dir, manifest)).toEqual([
      { path: "faces/pool/001.jpg", problem: "missing" },
      { path: "faces/pool/099.jpg", problem: "unlisted" },
      { path: "faces/sanna/2.jpg", problem: "tampered" },
    ]);
    // A cache that is not there: everything listed is missing, and nothing else is said.
    expect(verifyAssets(join(dir, "nowhere"), manifest).map((p) => p.problem)).toEqual(
      manifest.map(() => "missing"),
    );
    expect(demoAssetsDir("v1", "/home/x")).toBe("/home/x/.cache/kuutti-demo-photos/v1");
  });

  it("renders the manifest module as data, with every entry", () => {
    const dir = release(PICTURES);
    const text = renderManifest(manifestOf(dir));
    expect(text).toContain("export const PHOTOS_MANIFEST: readonly PhotoAsset[] = [");
    expect(text).toContain('    path: "faces/sanna/1.jpg",\n    sha256: "');
    expect(text).toContain('purpose: "negative:no-face"');
    expect(text.trim().endsWith("];")).toBe(true);
  });
});

describe("the faces of the population", () => {
  const pool = Array.from({ length: 12 }, (_, i) => ({
    path: `faces/pool/${String(i + 1).padStart(3, "0")}.jpg`,
    sha256: "0".repeat(64),
    purpose: "pool" as const,
  }));

  it("are drawn by seed, none to six per person, only for somebody with a profile, the same on every machine", () => {
    const people = generatePopulation({ size: 200, seed: 73 });
    const faces = facesForPopulation(people, pool, 73);
    const again = facesForPopulation(people, pool, 73);
    expect([...faces.entries()]).toEqual([...again.entries()]);
    for (const [label, own] of faces) {
      const person = people.find((p) => p.label === label);
      expect(person?.profile, label).not.toBeNull();
      expect(own.length).toBeGreaterThanOrEqual(0);
      expect(own.length).toBeLessThanOrEqual(6);
      expect(new Set(own.map((a) => a.path)).size).toBe(own.length);
    }
    expect(faces.size).toBe(people.filter((p) => p.profile !== null).length);
    const counts = [...faces.values()].map((own) => own.length);
    expect(counts.some((n) => n === 0)).toBe(true);
    expect(counts.some((n) => n >= 3)).toBe(true);
    expect(facesForPopulation(people, pool, 7)).not.toEqual(faces);
    expect(facesForPopulation(people, [], 73).size).toBe(0);
  });
});

describe("the repository holds no picture", () => {
  it("has nothing but TypeScript under the seed, and an empty manifest until the release exists", () => {
    const seed = resolve(import.meta.dirname);
    const files = readdirSync(seed).filter((f) => statSync(join(seed, f)).isFile());
    expect(files.filter((f) => !f.endsWith(".ts"))).toEqual([]);
    for (const asset of PHOTOS_MANIFEST) {
      expect(purposeOf(asset.path), asset.path).not.toBeNull();
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
