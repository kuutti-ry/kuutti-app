import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import type { SyntheticPerson } from "./population.ts";
import { createRandom } from "./rng.ts";

/**
 * The demo's pictures (#142, ADR-014 §7): generated faces for the personas
 * and a pool for the population, and the negatives the moderation queue is
 * meant to refuse, in a private repository of their own, released by tag.
 * This repository holds the manifest (path, SHA-256, purpose) and nothing
 * binary; `pnpm demo:assets` fetches a release into the cache and refuses a
 * file whose checksum differs, and the loaders push every picture through
 * the real upload pipeline (rule 4).
 */
export const PHOTOS_REPO = "kuutti-ry/kuutti-app-demo-photos";
export const PHOTOS_RELEASE = "v1";

/** `persona:<key>` the persona's own set, `pool` a face of the population, `negative:<name>` a picture the check refuses. */
export type PhotoPurpose = `persona:${string}` | "pool" | `negative:${string}`;

export type PhotoAsset = {
  /** Relative to the release's root, with forward slashes: `faces/sanna/1.jpg`. */
  path: string;
  /** Hex SHA-256 of the file's bytes. */
  sha256: string;
  purpose: PhotoPurpose;
};

/** Where a release is cached: `~/.cache/kuutti-demo-photos/<tag>`. */
export function demoAssetsDir(tag: string = PHOTOS_RELEASE, home: string = homedir()): string {
  return join(home, ".cache", "kuutti-demo-photos", tag);
}

const PICTURE = /\.(jpe?g|png|webp)$/i;

/** What a path in the release says the picture is for; null for a file the layout does not know. */
export function purposeOf(path: string): PhotoPurpose | null {
  const parts = path.split("/");
  if (!PICTURE.test(path)) return null;
  if (parts.length === 3 && parts[0] === "faces") {
    return parts[1] === "pool" ? "pool" : `persona:${parts[1]}`;
  }
  if (parts.length === 2 && parts[0] === "negatives") {
    return `negative:${(parts[1] as string).replace(PICTURE, "")}`;
  }
  return null;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function filesUnder(dir: string, base: string = dir): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return filesUnder(path, base);
    return [relative(base, path).split(sep).join("/")];
  });
}

/**
 * The manifest of a directory of pictures, sorted by path. A file the layout
 * does not know (a README, a licence, the manifest itself) is left out; a
 * picture in an unknown place is refused, so a misplaced face is noticed when
 * the manifest is written and not when a persona has no photos.
 */
export function manifestOf(dir: string): PhotoAsset[] {
  const assets: PhotoAsset[] = [];
  for (const path of filesUnder(dir).sort()) {
    const purpose = purposeOf(path);
    if (purpose === null) {
      if (PICTURE.test(path)) throw new Error(`${path}: a picture outside faces/ and negatives/`);
      continue;
    }
    assets.push({ path, sha256: sha256(readFileSync(join(dir, path))), purpose });
  }
  return assets;
}

export type AssetProblem = { path: string; problem: "missing" | "tampered" | "unlisted" };

/**
 * Every listed file present with its checksum, and no picture that is not
 * listed: a tampered or added file is named, never used. Reads every byte of
 * every file; a release is a few dozen pictures.
 */
export function verifyAssets(dir: string, manifest: readonly PhotoAsset[]): AssetProblem[] {
  const problems: AssetProblem[] = [];
  const listed = new Set(manifest.map((a) => a.path));
  for (const asset of manifest) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(dir, asset.path));
    } catch {
      problems.push({ path: asset.path, problem: "missing" });
      continue;
    }
    if (sha256(bytes) !== asset.sha256) problems.push({ path: asset.path, problem: "tampered" });
  }
  let present: string[] = [];
  try {
    present = filesUnder(dir);
  } catch {
    // A directory that is not there: every listed file is missing already.
  }
  for (const path of present) {
    if (PICTURE.test(path) && !listed.has(path)) problems.push({ path, problem: "unlisted" });
  }
  return problems.sort((a, b) => a.path.localeCompare(b.path));
}

/** The pictures of one purpose, in the order of their paths. */
export function assetsFor(manifest: readonly PhotoAsset[], purpose: PhotoPurpose): PhotoAsset[] {
  return manifest.filter((a) => a.purpose === purpose).sort((a, b) => a.path.localeCompare(b.path));
}

/** The negatives, by name: what the moderation queue is meant to refuse. */
export function negativesOf(manifest: readonly PhotoAsset[]): Map<string, PhotoAsset> {
  const out = new Map<string, PhotoAsset>();
  for (const asset of manifest) {
    if (asset.purpose.startsWith("negative:"))
      out.set(asset.purpose.slice("negative:".length), asset);
  }
  return out;
}

/** How many faces a person of the population has: most have a few, some none, a few the whole grid. */
const FACES_PER_PERSON = { 0: 15, 1: 15, 2: 20, 3: 25, 4: 12, 5: 8, 6: 5 } as const;

/**
 * Which faces of the pool each person of the population gets, by label, drawn
 * from the population's own seed so that two machines give the same people
 * the same pictures (ADR-014 §8). Only somebody with a profile has photos;
 * a face is used by more than one person when the pool is smaller than the
 * population, which is what the pool is for.
 */
export function facesForPopulation(
  people: readonly SyntheticPerson[],
  pool: readonly PhotoAsset[],
  seed: number,
): Map<string, PhotoAsset[]> {
  const rng = createRandom((seed ^ 0x9e3779b9) >>> 0);
  const faces = new Map<string, PhotoAsset[]>();
  if (pool.length === 0) return faces;
  for (const person of people) {
    if (person.profile === null) continue;
    const count = Math.min(Number(rng.weighted(FACES_PER_PERSON)), pool.length);
    faces.set(person.label, rng.sample(pool, count));
  }
  return faces;
}

/** The manifest module as `pnpm demo:assets -- --manifest` writes it: data, generated, never edited by hand. */
export function renderManifest(assets: readonly PhotoAsset[]): string {
  // One field per line, as Biome formats an object too long for one line.
  const rows = assets
    .map(
      (a) =>
        `  {\n    path: ${JSON.stringify(a.path)},\n    sha256: ${JSON.stringify(a.sha256)},\n    purpose: ${JSON.stringify(a.purpose)},\n  },`,
    )
    .join("\n");
  return `import type { PhotoAsset } from "./photos.ts";

// Written by \`pnpm demo:assets -- --manifest <dir>\` from the pictures of
// release ${PHOTOS_RELEASE} of ${PHOTOS_REPO} (#142, ADR-014 §7): every
// file's path, SHA-256 and purpose. The pictures themselves are never in this
// repository; a test refuses a binary under packages/db/src/seed. Empty until
// the release exists: with no entry, no persona and nobody of the population
// gets a photo, and the commands say so.
export const PHOTOS_MANIFEST: readonly PhotoAsset[] = [
${rows}
];
`;
}
